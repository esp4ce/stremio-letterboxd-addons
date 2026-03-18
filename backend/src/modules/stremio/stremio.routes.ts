import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  findUserById,
  findUserByLetterboxdUsername,
  getDecryptedRefreshToken,
  getUserPreferences,
  updateUser,
  User,
} from '../../db/repositories/user.repository.js';
import {
  AuthenticatedClient,
  createAuthenticatedClient,
  refreshAccessToken,
  WatchlistFilm,
  LogEntry,
  ListEntry,
  UserList,
  ActivityItem,
  FilmRelationshipUpdate,
  getWatchlist as rawGetWatchlist,
  getListEntries as rawGetListEntries,
  getList as rawGetList,
  getFilms as rawGetFilms,
  searchMemberByUsername as rawSearchMemberByUsername,
  getMember as rawGetMember,
} from '../letterboxd/letterboxd.client.js';
import { generateManifest, generateDynamicManifest, generatePublicManifest, SORT_LABEL_TO_API, SORT_VARIANT_KEYS } from './stremio.service.js';
import { genreNameToCode } from '../letterboxd/letterboxd.client.js';
import {
  transformWatchlistToMetas,
  transformLogEntriesToMetas,
  transformActivityToMetas,
  transformListEntriesToMetas,
  cacheFilmMapping,
  getImdbId,
  getTmdbId,
  getPosterUrl,
  buildPosterUrl,
  StremioMeta,
} from './catalog.service.js';
import { buildLetterboxdStreams, findFilmByImdb, getRawCinemetaMeta, getFilmRatingData, getPopularReviewsText } from './meta.service.js';
import { generateRatedPoster } from './poster.service.js';
import { createChildLogger } from '../../lib/logger.js';
import {
  userListsCache,
  popularCatalogCache,
  top250CatalogCache,
  memberIdCache,
  publicWatchlistCache,
  publicListCache,
  listNameCache,
  likedFilmsCache,
  userClientCache,
  getUserCatalogCached,
  setUserCatalog,
  invalidateUserCatalogs,
  cacheMetrics,
  recommendationCache,
  tmdbToImdbCache,
  userCatalogCache,
  watchedImdbCache,
} from '../../lib/cache.js';
import { trackEvent, type EventType } from '../../lib/metrics.js';
import { generateAnonId } from '../../lib/anonymous-id.js';
import { callWithAppToken } from '../../lib/app-client.js';
import { throttled } from '../../lib/retry.js';
import { decodeConfig, type PublicConfig } from '../../lib/config-encoding.js';
import { serverConfig, tmdbConfig } from '../../config/index.js';
import { verifyAction } from '../../lib/action-sign.js';
import { getTmdbRecommendations, getTmdbExternalIds } from '../../lib/tmdb-client.js';

const logger = createChildLogger('stremio-routes');

/**
 * Fisher-Yates shuffle (non-mutating)
 */
function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

const CATALOG_EVENT_MAP: Record<string, EventType> = {
  'letterboxd-popular': 'catalog_popular',
  'letterboxd-top250': 'catalog_top250',
  'letterboxd-watchlist': 'catalog_watchlist',
};

function catalogIdToEvent(id: string): EventType {
  return CATALOG_EVENT_MAP[id] ?? (id.startsWith('letterboxd-list-') ? 'catalog_list' : 'catalog_popular');
}

/** Track a Tier 1 event — resolve user_id from DB if username known, else anonymous fallback */
function trackTier1(event: EventType, cfg: PublicConfig, request: FastifyRequest, extra?: Record<string, unknown>): void {
  const userId = cfg.u ? findUserByLetterboxdUsername(cfg.u)?.id : undefined;
  trackEvent(event, userId, { tier: 1, ...extra }, userId ? undefined : generateAnonId(request));
}

const IMDB_REGEX = /^tt\d{1,10}$/;

// Stremio expects pages of this size; it requests the next page when it receives exactly this many items
const CATALOG_PAGE_SIZE = 100;

// Top 250 Narrative Feature Films list by Dave (LID)
const TOP_250_LIST_ID = '8HjM';

const actionParamsSchema = {
  type: 'object' as const,
  properties: {
    userId: { type: 'string' as const, pattern: '^[0-9a-f]{32}$' },
    action: { type: 'string' as const, enum: ['watched', 'liked', 'watchlist'] },
    filmId: { type: 'string' as const, pattern: '^[a-zA-Z0-9]+$' },
  },
  required: ['userId', 'action', 'filmId'] as const,
};

const rateParamsSchema = {
  type: 'object' as const,
  properties: {
    userId: { type: 'string' as const, pattern: '^[0-9a-f]{32}$' },
    filmId: { type: 'string' as const, pattern: '^[a-zA-Z0-9]+$' },
  },
  required: ['userId', 'filmId'] as const,
};

function sendHtml(reply: FastifyReply, html: string, statusCode = 200) {
  return reply
    .status(statusCode)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'")
    .header('X-Content-Type-Options', 'nosniff')
    .send(html);
}

/**
 * Parse Stremio extra params like "skip=20" or "genre=Action"
 */
function parseExtra(extra?: string): Record<string, string> {
  if (!extra) return {};
  const params: Record<string, string> = {};
  const parts = extra.split('&');
  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key && value !== undefined) {
      params[key] = decodeURIComponent(value);
    }
  }
  return params;
}

function parseCombinedFilter(extra?: string): {
  skip: number;
  includeGenre?: string[];
  decade?: number;
  sort?: string;
  isShuffle: boolean;
  isNotWatched: boolean;
} {
  const params = parseExtra(extra);
  const skip = params['skip'] ? parseInt(params['skip'], 10) : 0;
  const label = params['genre'];

  if (!label) return { skip, isShuffle: false, isNotWatched: false };

  // Sort detection
  if (label === 'Shuffle') return { skip, isShuffle: true, isNotWatched: false };
  if (label === 'Not Watched') return { skip, isShuffle: false, isNotWatched: true };
  if (SORT_LABEL_TO_API[label]) return { skip, sort: SORT_LABEL_TO_API[label], isShuffle: false, isNotWatched: false };

  // Decade detection: "1990s" → 1990
  const decadeMatch = label.match(/^(\d{4})s$/);
  if (decadeMatch) return { skip, decade: parseInt(decadeMatch[1]!, 10), isShuffle: false, isNotWatched: false };

  // Genre detection: "Comedy" → ['7I']
  const code = genreNameToCode(label);
  if (code) return { skip, includeGenre: [code], isShuffle: false, isNotWatched: false };

  return { skip, isShuffle: false, isNotWatched: false };
}

/**
 * Create authenticated client for a user (with LRU token cache)
 */
async function createClientForUser(user: User): Promise<AuthenticatedClient> {
  // Check cached client — reuse if token still valid (60s margin)
  const cached = userClientCache.get(user.id);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    cacheMetrics.tokenHits++;
    logger.debug({ userId: user.id }, 'Token cache hit');
    return cached.client;
  }
  cacheMetrics.tokenMisses++;

  const refreshToken = getDecryptedRefreshToken(user);
  const tokens = await refreshAccessToken(refreshToken);

  // Update stored refresh token if it changed
  if (tokens.refresh_token !== refreshToken) {
    updateUser(user.id, {
      refreshToken: tokens.refresh_token,
      tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    });
  }

  const expiresAt = Date.now() + tokens.expires_in * 1000;

  const client = createAuthenticatedClient(
    tokens.access_token,
    tokens.refresh_token,
    user.letterboxd_id,
    (newTokens) => {
      updateUser(user.id, {
        refreshToken: newTokens.refresh_token,
        tokenExpiresAt: new Date(Date.now() + newTokens.expires_in * 1000),
      });
      // Update cache with new expiry on token refresh
      userClientCache.set(user.id, {
        client,
        expiresAt: Date.now() + newTokens.expires_in * 1000,
      });
    }
  );

  userClientCache.set(user.id, { client, expiresAt });
  logger.debug({ userId: user.id }, 'Token cache miss — refreshed');

  return new Proxy(client, {
    get(target, prop) {
      const val = target[prop as keyof AuthenticatedClient];
      if (typeof val !== 'function') return val;
      return (...args: unknown[]) => throttled(() => (val as (...a: unknown[]) => Promise<unknown>).apply(target, args));
    },
  });
}

/**
 * Get the set of IMDb IDs the user has watched (cached 5 min)
 */
async function getWatchedImdbIds(user: User): Promise<Set<string>> {
  const cached = watchedImdbCache.get(user.id);
  if (cached) return cached.ids;

  const client = await createClientForUser(user);
  const ids = new Set<string>();
  let cursor: string | undefined;
  let page = 0;

  do {
    page++;
    const watched = await client.getFilms({
      member: user.letterboxd_id,
      memberRelationship: 'Watched',
      perPage: 100,
      cursor,
    });
    for (const film of watched.items) {
      const imdb = getImdbId(film);
      if (imdb) ids.add(imdb);
    }
    cursor = watched.cursor;
  } while (cursor && page < 10);

  watchedImdbCache.set(user.id, { ids });
  logger.debug({ userId: user.id, count: ids.size }, 'Watched IMDb IDs cached');
  return ids;
}

// ── Cache key builders (single source of truth) ─────────────────────────────

function filterSuffix(genre?: string[], decade?: number): string {
  const parts: string[] = [];
  if (genre?.length) parts.push(`g:${genre.join(',')}`);
  if (decade) parts.push(`d:${decade}`);
  return parts.length ? `:${parts.join(':')}` : '';
}

function cacheKeyWatchlist(userId: string, showRatings: boolean, sort?: string, genre?: string[], decade?: number) {
  return `user:${userId}:watchlist:${showRatings}:${sort || 'default'}${filterSuffix(genre, decade)}`;
}
function cacheKeyDiary(userId: string, showRatings: boolean, sort?: string) {
  return `user:${userId}:diary:${showRatings}:${sort || 'default'}`;
}
function cacheKeyFriends(userId: string, showRatings: boolean) {
  return `user:${userId}:friends:${showRatings}`;
}
function cacheKeyLiked(userId: string, showRatings: boolean, sort?: string, genre?: string[], decade?: number) {
  return `user:${userId}:liked:${showRatings}:${sort || 'default'}${filterSuffix(genre, decade)}`;
}
function cacheKeyList(userId: string, listId: string, showRatings: boolean, sort?: string, genre?: string[], decade?: number) {
  return `user:${userId}:list:${listId}:${showRatings}:${sort || 'default'}${filterSuffix(genre, decade)}`;
}
function cacheKeyReco(userId: string, sort?: string) {
  return `reco:${userId}:${sort ?? 'default'}`;
}
function cacheKeyPopular(showRatings: boolean, sort?: string, genre?: string[], decade?: number) {
  return `popular:${showRatings}:${sort || 'FilmPopularityThisWeek'}${filterSuffix(genre, decade)}`;
}
function cacheKeyTop250(showRatings: boolean, sort?: string, genre?: string[], decade?: number) {
  return `top250:${showRatings}:${sort || 'default'}${filterSuffix(genre, decade)}`;
}
function cacheKeyPublicWatchlist(memberId: string, showRatings: boolean, sort?: string, genre?: string[], decade?: number) {
  return `watchlist:${memberId}:${showRatings}:${sort || 'default'}${filterSuffix(genre, decade)}`;
}

/**
 * Read the full (unpaginated) catalog from the appropriate cache.
 * Returns undefined if not found — caller should fall back to paginated result.
 */
function getFullCatalogFromCache(
  catalogId: string,
  userId: string,
  showRatings: boolean,
  sort?: string,
  extMemberId?: string,
  includeGenre?: string[],
  decade?: number,
): StremioMeta[] | undefined {
  if (catalogId === 'letterboxd-watchlist')
    return userCatalogCache.get(cacheKeyWatchlist(userId, showRatings, sort, includeGenre, decade))?.metas;
  if (catalogId === 'letterboxd-diary')
    return userCatalogCache.get(cacheKeyDiary(userId, showRatings, sort))?.metas;
  if (catalogId === 'letterboxd-friends')
    return userCatalogCache.get(cacheKeyFriends(userId, showRatings))?.metas;
  if (catalogId === 'letterboxd-liked-films')
    return userCatalogCache.get(cacheKeyLiked(userId, showRatings, sort, includeGenre, decade))?.metas;
  if (catalogId === 'letterboxd-recommended')
    return recommendationCache.get(cacheKeyReco(userId, sort))?.metas;
  if (catalogId === 'letterboxd-popular')
    return popularCatalogCache.get(cacheKeyPopular(showRatings, sort, includeGenre, decade))?.metas;
  if (catalogId === 'letterboxd-top250')
    return top250CatalogCache.get(cacheKeyTop250(showRatings, sort, includeGenre, decade))?.metas;
  if (catalogId.startsWith('letterboxd-watchlist-') && extMemberId)
    return publicWatchlistCache.get(cacheKeyPublicWatchlist(extMemberId, showRatings, sort, includeGenre, decade))?.metas;
  if (catalogId.startsWith('letterboxd-list-')) {
    const listId = catalogId.replace('letterboxd-list-', '');
    return userCatalogCache.get(cacheKeyList(userId, listId, showRatings, sort, includeGenre, decade))?.metas;
  }
  return undefined;
}

/**
 * Fetch watchlist and return Stremio metas with pagination
 */
async function fetchWatchlistCatalog(
  user: User,
  skip: number = 0,
  showRatings: boolean = true,
  sort?: string,
  includeGenre?: string[],
  decade?: number
): Promise<{ metas: StremioMeta[] }> {
  const cacheKey = cacheKeyWatchlist(user.id, showRatings, sort, includeGenre, decade);
  const cached = getUserCatalogCached(cacheKey, skip, CATALOG_PAGE_SIZE);
  if (cached) return cached;

  const client = await createClientForUser(user);

  const allFilms: WatchlistFilm[] = [];
  let cursor: string | undefined;
  let page = 0;

  do {
    page++;
    const watchlist = await client.getWatchlist({ perPage: 100, cursor, sort, includeGenre, decade });
    logger.info({ page, itemsCount: watchlist.items.length, hasCursor: !!watchlist.cursor }, 'Watchlist page fetched');
    allFilms.push(...watchlist.items);
    cursor = watchlist.cursor;
  } while (cursor && page < 10);

  const allMetas = transformWatchlistToMetas(allFilms, showRatings);
  for (const film of allFilms) cacheFilmMapping(film);

  const result = setUserCatalog(user.id, cacheKey, allMetas, skip, CATALOG_PAGE_SIZE);
  logger.info({ total: allMetas.length, skip, returned: result.metas.length, username: user.letterboxd_username }, 'Watchlist fetched');
  return result;
}

/**
 * Fetch diary (recent activity) and return Stremio metas with pagination
 */
async function fetchDiaryCatalog(
  user: User,
  skip: number = 0,
  showRatings: boolean = true,
  sort?: string
): Promise<{ metas: StremioMeta[] }> {
  const cacheKey = cacheKeyDiary(user.id, showRatings, sort);
  const cached = getUserCatalogCached(cacheKey, skip, CATALOG_PAGE_SIZE);
  if (cached) return cached;

  const client = await createClientForUser(user);

  const allEntries: LogEntry[] = [];
  let cursor: string | undefined;
  let page = 0;

  do {
    page++;
    const response = await client.getMemberLogEntries({ perPage: 100, cursor, sort });
    logger.info({ page, itemsCount: response.items.length, hasCursor: !!response.cursor }, 'Diary page fetched');
    allEntries.push(...response.items);
    cursor = response.cursor;
  } while (cursor && page < 5);

  const allMetas = transformLogEntriesToMetas(allEntries, showRatings);

  const result = setUserCatalog(user.id, cacheKey, allMetas, skip, CATALOG_PAGE_SIZE);
  logger.info({ total: allMetas.length, skip, returned: result.metas.length, username: user.letterboxd_username }, 'Diary fetched');
  return result;
}

/**
 * Fetch friends activity and return Stremio metas
 */
async function fetchFriendsCatalog(
  user: User,
  skip: number = 0,
  showRatings: boolean = true
): Promise<{ metas: StremioMeta[] }> {
  const cacheKey = cacheKeyFriends(user.id, showRatings);
  const cached = getUserCatalogCached(cacheKey, skip, CATALOG_PAGE_SIZE);
  if (cached) return cached;

  const client = await createClientForUser(user);

  const allItems: ActivityItem[] = [];
  let nextStart: string | undefined;
  let page = 0;

  do {
    page++;
    const response = await client.getFriendsActivity({ perPage: 100, start: nextStart });
    logger.info({ page, itemsCount: response.items.length, hasNext: !!response.next }, 'Friends activity page fetched');
    allItems.push(...response.items);
    nextStart = response.next?.replace('start=', '');
  } while (nextStart && page < 3);

  const allMetas = transformActivityToMetas(allItems, user.letterboxd_id, showRatings);

  const result = setUserCatalog(user.id, cacheKey, allMetas, skip, CATALOG_PAGE_SIZE);
  logger.info({ total: allMetas.length, skip, returned: result.metas.length, username: user.letterboxd_username }, 'Friends activity fetched');
  return result;
}

/**
 * Fetch a specific list's films and return Stremio metas
 */
async function fetchListCatalog(
  user: User,
  listId: string,
  skip: number = 0,
  showRatings: boolean = true,
  sort?: string,
  includeGenre?: string[],
  decade?: number
): Promise<{ metas: StremioMeta[] }> {
  const cacheKey = cacheKeyList(user.id, listId, showRatings, sort, includeGenre, decade);
  const cached = getUserCatalogCached(cacheKey, skip, CATALOG_PAGE_SIZE);
  if (cached) return cached;

  const client = await createClientForUser(user);

  const allEntries: ListEntry[] = [];
  let cursor: string | undefined;
  let page = 0;

  do {
    page++;
    const response = await client.getListEntries(listId, { perPage: 100, cursor, sort, includeGenre, decade });
    logger.info({ page, listId, itemsCount: response.items.length, hasCursor: !!response.cursor }, 'List page fetched');
    allEntries.push(...response.items);
    cursor = response.cursor;
  } while (cursor && page < 10);

  const allMetas = transformListEntriesToMetas(allEntries, showRatings);
  for (const entry of allEntries) cacheFilmMapping(entry.film);

  const result = setUserCatalog(user.id, cacheKey, allMetas, skip, CATALOG_PAGE_SIZE);
  logger.info({ total: allMetas.length, skip, returned: result.metas.length, listId, username: user.letterboxd_username }, 'List fetched');
  return result;
}


/**
 * Fetch liked films and return Stremio metas with pagination
 */
async function fetchLikedFilmsCatalog(
  user: User,
  skip: number = 0,
  showRatings: boolean = true,
  sort?: string,
  includeGenre?: string[],
  decade?: number
): Promise<{ metas: StremioMeta[] }> {
  const cacheKey = cacheKeyLiked(user.id, showRatings, sort, includeGenre, decade);
  const cached = getUserCatalogCached(cacheKey, skip, CATALOG_PAGE_SIZE);
  if (cached) return cached;

  const client = await createClientForUser(user);

  const allFilms: WatchlistFilm[] = [];
  let cursor: string | undefined;
  let page = 0;

  do {
    page++;
    const response = await client.getFilms({
      member: user.letterboxd_id,
      memberRelationship: 'Liked',
      includeFriends: 'None',
      sort: sort || 'DateLatestFirst',
      perPage: 100,
      cursor,
      includeGenre,
      decade,
    });
    logger.info({ page, itemsCount: response.items.length, hasCursor: !!response.cursor }, 'Liked films page fetched');
    allFilms.push(...response.items);
    cursor = response.cursor;
  } while (cursor && page < 10);

  const allMetas = transformWatchlistToMetas(allFilms, showRatings);
  for (const film of allFilms) cacheFilmMapping(film);

  const result = setUserCatalog(user.id, cacheKey, allMetas, skip, CATALOG_PAGE_SIZE);
  logger.info({ total: allMetas.length, skip, returned: result.metas.length, username: user.letterboxd_username }, 'Liked films fetched');
  return result;
}

/**
 * Fetch personalized recommendations based on user's rated/liked films → TMDB recommendations → aggregate by frequency
 */
async function fetchRecommendationsCatalog(
  user: User,
  skip: number = 0,
  showRatings: boolean = true,
  sort?: string,
): Promise<{ metas: StremioMeta[] }> {
  const apiKey = tmdbConfig.apiKey;
  if (!apiKey) return { metas: [] };

  const cacheKey = cacheKeyReco(user.id, sort);
  const cached = recommendationCache.get(cacheKey);
  if (cached) {
    return { metas: cached.metas.slice(skip, skip + CATALOG_PAGE_SIZE) };
  }

  const client = await createClientForUser(user);

  // 1. Collect seed films (rated + liked + watchlist in parallel where possible)
  const seeds: WatchlistFilm[] = [];
  const watchlistImdbIds = new Set<string>();
  // Pre-populate exclusion set from seeds to avoid redundant watched-films fetch later
  const watchedImdbIdsFromSeeds = new Set<string>();

  // Fetch rated, liked, and first watchlist page in parallel (all independent)
  const [ratedResult, likedResult, watchlistFirstPage] = await Promise.allSettled([
    client.getFilms({
      member: user.letterboxd_id,
      memberRelationship: 'Watched',
      sort: 'AuthenticatedMemberRatingHighToLow',
      perPage: 100,
    }),
    client.getFilms({
      member: user.letterboxd_id,
      memberRelationship: 'Liked',
      perPage: 50,
    }),
    client.getWatchlist({ perPage: 100 }),
  ]);

  // Priority 1: rated films (≥3★) — also collect all IMDb IDs for exclusion
  if (ratedResult.status === 'fulfilled') {
    for (const film of ratedResult.value.items) {
      const imdb = getImdbId(film);
      if (imdb) watchedImdbIdsFromSeeds.add(imdb);
    }
    const highRated = ratedResult.value.items.filter((f) => f.rating != null && f.rating >= 3);
    seeds.push(...highRated.slice(0, 50));
  } else {
    logger.warn({ err: ratedResult.reason, userId: user.id }, 'Failed to fetch rated films for recommendations');
  }

  // Priority 2: liked films (always included, weight=1.0)
  if (likedResult.status === 'fulfilled') {
    for (const film of likedResult.value.items) {
      if (seeds.length >= 80) break;
      if (!seeds.some((s) => s.id === film.id)) seeds.push(film);
      const imdb = getImdbId(film);
      if (imdb) watchedImdbIdsFromSeeds.add(imdb);
    }
  } else if (likedResult.status === 'rejected') {
    logger.warn({ err: likedResult.reason, userId: user.id }, 'Failed to fetch liked films for recommendations');
  }

  // Watchlist: first page already fetched, paginate remaining
  if (watchlistFirstPage.status === 'fulfilled') {
    for (const film of watchlistFirstPage.value.items) {
      const imdbId = getImdbId(film);
      if (imdbId) watchlistImdbIds.add(imdbId);
      if (seeds.length < 20 && !seeds.some((s) => s.id === film.id)) {
        seeds.push(film);
      }
    }
    let cursor = watchlistFirstPage.value.cursor;
    let page = 1;
    while (cursor && page < 10) {
      try {
        page++;
        const wl = await client.getWatchlist({ perPage: 100, cursor });
        for (const film of wl.items) {
          const imdbId = getImdbId(film);
          if (imdbId) watchlistImdbIds.add(imdbId);
          if (seeds.length < 20 && !seeds.some((s) => s.id === film.id)) {
            seeds.push(film);
          }
        }
        cursor = wl.cursor;
      } catch (err) {
        logger.warn({ err, userId: user.id }, 'Failed to fetch watchlist page for recommendations');
        break;
      }
    }
  } else {
    logger.warn({ err: watchlistFirstPage.reason, userId: user.id }, 'Failed to fetch watchlist for recommendations');
  }

  if (seeds.length === 0) {
    recommendationCache.set(cacheKey, { metas: [] });
    return { metas: [] };
  }

  // 2. Extract TMDB IDs from seeds, keep rating weight per seed
  // Weight: 5★=2.0, 4.5★=1.5, 4★=1.0, 3★=0.5, likes=1.0, watchlist=0.5
  const seedEntries: { tmdbId: number; weight: number }[] = [];
  const seedImdbIds = new Set<string>();
  for (const film of seeds) {
    const tmdbId = getTmdbId(film);
    const imdb = getImdbId(film);
    if (imdb) seedImdbIds.add(imdb);
    cacheFilmMapping(film);
    if (!tmdbId) continue;
    const rating = film.rating;
    const weight = rating == null ? 1.0 : rating >= 5 ? 2.0 : rating >= 4.5 ? 1.5 : rating >= 4 ? 1.0 : 0.5;
    seedEntries.push({ tmdbId, weight });
  }

  // 3. Fan out to TMDB recommendations (max 50 seeds)
  const tmdbSeeds = seedEntries.slice(0, 50);
  const recoResults = await Promise.allSettled(
    tmdbSeeds.map(({ tmdbId }) => getTmdbRecommendations(tmdbId, apiKey)),
  );

  // 4. Aggregate by weighted score (higher-rated seeds contribute more)
  const scoreMap = new Map<number, { score: number; title: string; releaseYear?: number; posterPath?: string | null }>();
  for (let i = 0; i < recoResults.length; i++) {
    const result = recoResults[i];
    if (result?.status !== 'fulfilled') continue;
    const weight = tmdbSeeds[i]?.weight ?? 1;
    for (const reco of result.value) {
      const existing = scoreMap.get(reco.id);
      if (existing) {
        existing.score += weight;
      } else {
        const year = reco.release_date ? parseInt(reco.release_date.slice(0, 4), 10) : undefined;
        scoreMap.set(reco.id, {
          score: weight,
          title: reco.title,
          releaseYear: year && !isNaN(year) ? year : undefined,
          posterPath: reco.poster_path,
        });
      }
    }
  }

  // 5. Sort by weighted score, keep generous pool before exclusion
  const sorted = [...scoreMap.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 250);

  // 6. Resolve TMDB IDs → IMDb IDs progressively (batch of 30, early-exit when enough resolved)
  const RESOLVE_BATCH_SIZE = 30;
  const RESOLVE_TARGET = 60; // Need ~2x RECO_LIMIT to account for exclusions
  let resolvedCount = sorted.filter(([id]) => tmdbToImdbCache.get(String(id))).length;

  for (let i = 0; i < sorted.length && resolvedCount < RESOLVE_TARGET; i += RESOLVE_BATCH_SIZE) {
    const batch = sorted
      .slice(i, i + RESOLVE_BATCH_SIZE)
      .filter(([id]) => !tmdbToImdbCache.get(String(id)))
      .map(([id]) => id);

    if (batch.length === 0) continue;

    const results = await Promise.allSettled(
      batch.map((id) => getTmdbExternalIds(id, apiKey).then((ext) => ({ tmdbId: id, imdbId: ext.imdb_id }))),
    );
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.imdbId) {
        tmdbToImdbCache.set(String(result.value.tmdbId), result.value.imdbId);
        resolvedCount++;
      }
    }
  }

  // 7. Exclude already-watched films AND watchlist films
  //    Seeds from step 1 (rated + liked) already provided partial watched coverage.
  const excludeImdbIds = new Set([...seedImdbIds, ...watchlistImdbIds, ...watchedImdbIdsFromSeeds]);
  try {
    let cursor: string | undefined;
    let page = 0;
    do {
      page++;
      const watched = await client.getFilms({
        member: user.letterboxd_id,
        memberRelationship: 'Watched',
        perPage: 100,
        cursor,
      });
      for (const film of watched.items) {
        const imdb = getImdbId(film);
        if (imdb) excludeImdbIds.add(imdb);
      }
      cursor = watched.cursor;
    } while (cursor && page < 10);
    logger.debug({ excludeCount: excludeImdbIds.size }, 'Watched films collected for exclusion');
  } catch {
    // Non-critical — proceed with partial exclusion
  }

  // 8. Collect final films (after exclusion), capped at 30 for performance
  const RECO_LIMIT = 30;
  const finalFilms: Array<{ imdbId: string; tmdb: { title: string; year?: number; posterPath?: string | null } }> = [];
  for (const [tmdbId, info] of sorted) {
    if (finalFilms.length >= RECO_LIMIT) break;
    const imdbId = tmdbToImdbCache.get(String(tmdbId));
    if (!imdbId || excludeImdbIds.has(imdbId)) continue;
    finalFilms.push({ imdbId, tmdb: { title: info.title, year: info.releaseYear, posterPath: info.posterPath } });
  }
  logger.info({ finalFilmsCount: finalFilms.length, excludedCount: excludeImdbIds.size }, 'Recommendation pool after exclusion');

  // 9. Fetch Letterboxd community rating for the badge.
  //    findFilmByImdb handles 404s via Cinemeta+search fallback — necessary for badge coverage.
  //    Only the LID is used (metadata comes from TMDB, already in memory).
  //    Batch of 10 concurrent calls.
  const lbDataMap = new Map<string, { poster?: string; rating?: number }>();
  const LB_BATCH_SIZE = 10;
  for (let i = 0; i < finalFilms.length; i += LB_BATCH_SIZE) {
    const batch = finalFilms.slice(i, i + LB_BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async ({ imdbId }) => {
        const result = await findFilmByImdb(client, imdbId);
        if (!result) return;
        const poster = getPosterUrl(result.film);
        const stats = await client.getFilmStatistics(result.letterboxdFilmId);
        lbDataMap.set(imdbId, { poster, rating: stats.rating ?? undefined });
      }),
    );
  }
  logger.info({ withRating: lbDataMap.size, total: finalFilms.length }, 'Letterboxd data fetched for recommendations');

  // Build StremioMeta[] — Letterboxd poster + rating badge, TMDB as fallback for metadata
  const metas: StremioMeta[] = [];
  let rank = 0;
  for (const { imdbId, tmdb } of finalFilms) {
    rank++;
    const lb = lbDataMap.get(imdbId);
    const posterUrl = lb?.poster ?? (tmdb.posterPath ? `https://image.tmdb.org/t/p/w300${tmdb.posterPath}` : undefined);
    metas.push({
      id: imdbId,
      type: 'movie',
      name: tmdb.title,
      poster: showRatings ? buildPosterUrl(posterUrl, lb?.rating) : posterUrl,
      year: tmdb.year,
      description: `#${rank}`,
    });
  }

  // 9. Apply local sort (default: score order from TMDB aggregation)
  if (sort) {
    switch (sort) {
      case 'FilmName':
        metas.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'ReleaseDateLatestFirst':
        metas.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
        break;
      case 'ReleaseDateEarliestFirst':
        metas.sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
        break;
      case 'AverageRatingHighToLow':
        metas.sort((a, b) => {
          const ra = lbDataMap.get(a.id)?.rating ?? 0;
          const rb = lbDataMap.get(b.id)?.rating ?? 0;
          return rb - ra;
        });
        break;
      case 'AverageRatingLowToHigh':
        metas.sort((a, b) => {
          const ra = lbDataMap.get(a.id)?.rating ?? 0;
          const rb = lbDataMap.get(b.id)?.rating ?? 0;
          return ra - rb;
        });
        break;
      // default: keep score order
    }
    // Re-number ranks after sort
    for (let i = 0; i < metas.length; i++) {
      metas[i]!.description = `#${i + 1}`;
    }
  }

  // 10. Cache and return
  recommendationCache.set(cacheKey, { metas });
  logger.info({ total: metas.length, seeds: tmdbSeeds.length, username: user.letterboxd_username }, 'Recommendations generated');
  return { metas: metas.slice(skip, skip + CATALOG_PAGE_SIZE) };
}

/**
 * Fetch liked films for public tier (with app token)
 */
async function fetchLikedFilmsCatalogPublic(
  memberId: string,
  skip: number,
  showRatings: boolean,
  sort?: string,
  includeGenre?: string[],
  decade?: number
): Promise<{ metas: StremioMeta[] }> {
  const effectiveSort = sort || 'DateLatestFirst';
  const cacheKey = `liked:${memberId}:${showRatings}:${effectiveSort}${filterSuffix(includeGenre, decade)}`;
  const cached = likedFilmsCache.get(cacheKey);
  if (cached) {
    const metas = cached.metas.slice(skip, skip + CATALOG_PAGE_SIZE);
    return { metas };
  }

  const allFilms: WatchlistFilm[] = [];
  let cursor: string | undefined;
  let page = 0;

  do {
    page++;
    const response = await callWithAppToken((token) =>
      rawGetFilms(token, {
        member: memberId,
        memberRelationship: 'Liked',
        includeFriends: 'None',
        sort: effectiveSort,
        perPage: 100,
        cursor,
        includeGenre,
        decade,
      })
    );
    allFilms.push(...response.items);
    cursor = response.cursor;
  } while (cursor && page < 10);

  const allMetas = transformWatchlistToMetas(allFilms, showRatings);
  for (const film of allFilms) cacheFilmMapping(film);

  likedFilmsCache.set(cacheKey, { metas: allMetas });
  const metas = allMetas.slice(skip, skip + CATALOG_PAGE_SIZE);
  logger.info({ total: allMetas.length, skip, returned: metas.length, memberId }, 'Public liked films fetched');
  return { metas };
}

/**
 * Fetch user's lists for dynamic catalog generation
 */
async function fetchUserLists(user: User): Promise<UserList[]> {
  const cacheKey = `lists:${user.letterboxd_id}`;
  const cached = userListsCache.get(cacheKey);
  if (cached) {
    logger.debug({ cacheKey }, 'User lists cache hit');
    return cached.lists;
  }

  const client = await createClientForUser(user);

  const allLists: UserList[] = [];
  let cursor: string | undefined;
  let page = 0;

  do {
    page++;
    const response = await client.getUserLists({ perPage: 50, cursor });
    logger.info({ page, itemsCount: response.items.length, hasCursor: !!response.cursor }, 'Lists page fetched');
    allLists.push(...response.items);
    cursor = response.cursor;
  } while (cursor && page < 3); // Limit to 150 lists

  userListsCache.set(cacheKey, { lists: allLists });
  logger.info({ count: allLists.length, username: user.letterboxd_username }, 'User lists fetched');

  return allLists;
}

/**
 * Handle catalog request (shared logic for with/without extra params)
 */
async function handleCatalogRequest(
  userId: string,
  type: string,
  catalogId: string,
  extra?: string
): Promise<{ metas: StremioMeta[] }> {
  const user = findUserById(userId);
  if (!user) {
    throw new Error('User not found');
  }

  logger.info(
    { type, catalogId, extra, username: user.letterboxd_username },
    'Catalog request'
  );

  // Only handle movie catalogs
  if (type !== 'movie') {
    return { metas: [] };
  }

  // Extract sort variant from catalog ID (e.g. "letterboxd-watchlist--shuffle")
  let baseCatalogId = catalogId;
  let sortVariant: string | undefined;
  const variantSep = catalogId.lastIndexOf('--');
  if (variantSep > 0) {
    baseCatalogId = catalogId.substring(0, variantSep);
    sortVariant = catalogId.substring(variantSep + 2);
  }

  // Resolve sort/special from variant
  const variantConfig = sortVariant ? SORT_VARIANT_KEYS[sortVariant] : undefined;
  const variantSort = variantConfig?.sort;
  const isVariantShuffle = variantConfig?.special === 'shuffle';
  const isVariantNotWatched = variantConfig?.special === 'notWatched';

  const preferences = getUserPreferences(user);
  const showRatings = preferences?.showRatings !== false;

  // All catalogs now use the combined filter (sort + genre + decade in one dropdown)
  const parsed = parseCombinedFilter(extra);
  let { skip } = parsed;
  const sort = parsed.sort || variantSort;
  const isShuffle = parsed.isShuffle || isVariantShuffle;
  const isNotWatched = parsed.isNotWatched || isVariantNotWatched;
  const includeGenre = parsed.includeGenre;
  const decade = parsed.decade;

  // When filtering by "Not Watched", fetch from position 0 so the full catalog is cached
  const fetchSkip = isNotWatched ? 0 : skip;

  try {
    let result: { metas: StremioMeta[] };
    let resolvedExtMemberId: string | undefined;

    if (baseCatalogId === 'letterboxd-watchlist') {
      trackEvent('catalog_watchlist', userId);
      result = await fetchWatchlistCatalog(user, fetchSkip, showRatings, sort, includeGenre, decade);
    } else if (baseCatalogId === 'letterboxd-diary') {
      trackEvent('catalog_diary', userId);
      result = await fetchDiaryCatalog(user, fetchSkip, showRatings, sort);
    } else if (baseCatalogId === 'letterboxd-friends') {
      trackEvent('catalog_friends', userId);
      result = await fetchFriendsCatalog(user, fetchSkip, showRatings);
    } else if (baseCatalogId === 'letterboxd-liked-films') {
      trackEvent('catalog_liked', userId);
      result = await fetchLikedFilmsCatalog(user, fetchSkip, showRatings, sort, includeGenre, decade);
    } else if (baseCatalogId === 'letterboxd-recommended') {
      trackEvent('catalog_recommended', userId);
      result = await fetchRecommendationsCatalog(user, fetchSkip, showRatings, sort);
    } else if (baseCatalogId === 'letterboxd-popular') {
      trackEvent('catalog_popular', userId);
      result = await fetchPopularCatalogPublic(fetchSkip, showRatings, sort, includeGenre, decade);
    } else if (baseCatalogId === 'letterboxd-top250') {
      trackEvent('catalog_top250', userId);
      result = await fetchTop250CatalogPublic(fetchSkip, showRatings, sort, includeGenre, decade);
    } else if (baseCatalogId.startsWith('letterboxd-watchlist-')) {
      // External watchlist: letterboxd-watchlist-{username}
      const username = baseCatalogId.replace('letterboxd-watchlist-', '');
      trackEvent('catalog_watchlist', userId, { externalUsername: username });
      resolvedExtMemberId = await resolveMemberId(username) ?? undefined;
      if (resolvedExtMemberId) {
        result = await fetchWatchlistCatalogPublic(resolvedExtMemberId, fetchSkip, showRatings, sort, includeGenre, decade);
      } else {
        result = { metas: [] };
      }
    } else if (baseCatalogId.startsWith('letterboxd-list-')) {
      const listId = baseCatalogId.replace('letterboxd-list-', '');
      const listName = listNameCache.get(listId);
      trackEvent('catalog_list', userId, { listId, ...(listName && { listName }) });
      result = await fetchListCatalog(user, listId, fetchSkip, showRatings, sort, includeGenre, decade);
    } else {
      logger.warn({ catalogId: baseCatalogId }, 'Unknown catalog requested');
      return { metas: [] };
    }

    // "Not Watched" filter: get full catalog, remove watched films, re-paginate
    if (isNotWatched) {
      const fullMetas = getFullCatalogFromCache(baseCatalogId, user.id, showRatings, sort, resolvedExtMemberId);
      if (fullMetas) {
        const watchedIds = await getWatchedImdbIds(user);
        const filtered = fullMetas.filter(m => !watchedIds.has(m.id));
        logger.info({ catalogId: baseCatalogId, total: fullMetas.length, filtered: filtered.length, watched: watchedIds.size }, 'Not Watched filter applied');
        result = { metas: filtered.slice(skip, skip + CATALOG_PAGE_SIZE) };
      }
    }

    if (isShuffle) {
      result = { metas: shuffleArray(result.metas) };
    }

    return result;

  } catch (error) {
    logger.error({ error, userId, catalogId }, 'Failed to fetch catalog');
    return { metas: [] };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Public fetch functions (using service accounts)
// ═══════════════════════════════════════════════════════════════════════════

async function fetchPopularCatalogPublic(skip: number, showRatings: boolean, sort?: string, includeGenre?: string[], decade?: number): Promise<{ metas: StremioMeta[] }> {
  const effectiveSort = sort || 'FilmPopularityThisWeek';
  const cacheKey = cacheKeyPopular(showRatings, sort, includeGenre, decade);
  const cached = popularCatalogCache.get(cacheKey);
  if (cached) {
    const metas = cached.metas.slice(skip, skip + CATALOG_PAGE_SIZE);
    return { metas };
  }

  const allFilms: WatchlistFilm[] = [];
  let cursor: string | undefined;
  let page = 0;

  do {
    page++;
    const response = await callWithAppToken((token) =>
      rawGetFilms(token, { sort: effectiveSort, perPage: 100, cursor, includeGenre, decade })
    );
    allFilms.push(...response.items);
    cursor = response.cursor;
  } while (cursor && page < 10);

  const allMetas = transformWatchlistToMetas(allFilms, showRatings);
  for (const film of allFilms) cacheFilmMapping(film);

  popularCatalogCache.set(cacheKey, { metas: allMetas });
  const metas = allMetas.slice(skip, skip + CATALOG_PAGE_SIZE);
  logger.info({ total: allMetas.length, skip, returned: metas.length }, 'Public popular fetched');
  return { metas };
}

async function fetchTop250CatalogPublic(skip: number, showRatings: boolean, sort?: string, includeGenre?: string[], decade?: number): Promise<{ metas: StremioMeta[] }> {
  const cacheKey = cacheKeyTop250(showRatings, sort, includeGenre, decade);
  const cached = top250CatalogCache.get(cacheKey);
  if (cached) {
    const metas = cached.metas.slice(skip, skip + CATALOG_PAGE_SIZE);
    return { metas };
  }

  const allEntries: ListEntry[] = [];
  let cursor: string | undefined;
  let page = 0;

  do {
    page++;
    const response = await callWithAppToken((token) =>
      rawGetListEntries(token, TOP_250_LIST_ID, { perPage: 100, cursor, sort, includeGenre, decade })
    );
    allEntries.push(...response.items);
    cursor = response.cursor;
  } while (cursor && page < 5);

  const allMetas = transformListEntriesToMetas(allEntries, showRatings);
  for (const entry of allEntries) cacheFilmMapping(entry.film);

  top250CatalogCache.set(cacheKey, { metas: allMetas });
  const metas = allMetas.slice(skip, skip + CATALOG_PAGE_SIZE);
  logger.info({ total: allMetas.length, skip, returned: metas.length }, 'Public top250 fetched');
  return { metas };
}

async function resolveMemberId(username: string): Promise<string | null> {
  const cacheKey = `member:${username.toLowerCase()}`;
  const cached = memberIdCache.get(cacheKey);
  if (cached) return cached;

  const member = await callWithAppToken((token) =>
    rawSearchMemberByUsername(token, username)
  );

  if (!member) return null;

  memberIdCache.set(cacheKey, member.id);
  return member.id;
}

async function fetchWatchlistCatalogPublic(
  memberId: string,
  skip: number,
  showRatings: boolean,
  sort?: string,
  includeGenre?: string[],
  decade?: number
): Promise<{ metas: StremioMeta[] }> {
  const cacheKey = cacheKeyPublicWatchlist(memberId, showRatings, sort, includeGenre, decade);
  const cached = publicWatchlistCache.get(cacheKey);
  if (cached) {
    const metas = cached.metas.slice(skip, skip + CATALOG_PAGE_SIZE);
    return { metas };
  }

  const allFilms: WatchlistFilm[] = [];
  let cursor: string | undefined;
  let page = 0;

  do {
    page++;
    const response = await callWithAppToken((token) =>
      rawGetWatchlist(token, memberId, { perPage: 100, cursor, sort, includeGenre, decade })
    );
    allFilms.push(...response.items);
    cursor = response.cursor;
  } while (cursor && page < 10);

  const allMetas = transformWatchlistToMetas(allFilms, showRatings);
  for (const film of allFilms) cacheFilmMapping(film);

  publicWatchlistCache.set(cacheKey, { metas: allMetas });
  const metas = allMetas.slice(skip, skip + CATALOG_PAGE_SIZE);
  logger.info({ total: allMetas.length, skip, returned: metas.length, memberId }, 'Public watchlist fetched');
  return { metas };
}

async function fetchListCatalogPublic(
  listId: string,
  skip: number,
  showRatings: boolean,
  sort?: string,
  includeGenre?: string[],
  decade?: number
): Promise<{ metas: StremioMeta[] }> {
  const cacheKey = `list:${listId}:${showRatings}:${sort || 'default'}${filterSuffix(includeGenre, decade)}`;
  const cached = publicListCache.get(cacheKey);
  if (cached) {
    const metas = cached.metas.slice(skip, skip + CATALOG_PAGE_SIZE);
    return { metas };
  }

  const allEntries: ListEntry[] = [];
  let cursor: string | undefined;
  let page = 0;

  do {
    page++;
    const response = await callWithAppToken((token) =>
      rawGetListEntries(token, listId, { perPage: 100, cursor, sort, includeGenre, decade })
    );
    allEntries.push(...response.items);
    cursor = response.cursor;
  } while (cursor && page < 10);

  const allMetas = transformListEntriesToMetas(allEntries, showRatings);
  for (const entry of allEntries) cacheFilmMapping(entry.film);

  publicListCache.set(cacheKey, { metas: allMetas });
  const metas = allMetas.slice(skip, skip + CATALOG_PAGE_SIZE);
  logger.info({ total: allMetas.length, skip, returned: metas.length, listId }, 'Public list fetched');
  return { metas };
}

async function handlePublicCatalogRequest(
  cfg: PublicConfig,
  catalogId: string,
  extra?: string,
  memberId?: string | null
): Promise<{ metas: StremioMeta[] }> {
  const showRatings = cfg.r;

  // Extract sort variant from catalog ID
  let baseCatalogId = catalogId;
  let sortVariant: string | undefined;
  const variantSep = catalogId.lastIndexOf('--');
  if (variantSep > 0) {
    baseCatalogId = catalogId.substring(0, variantSep);
    sortVariant = catalogId.substring(variantSep + 2);
  }

  const variantConfig = sortVariant ? SORT_VARIANT_KEYS[sortVariant] : undefined;

  // Parse combined filter (sort + genre + decade)
  const parsed = parseCombinedFilter(extra);
  const { skip, includeGenre, decade } = parsed;
  const isShuffle = parsed.isShuffle || (variantConfig?.special === 'shuffle');
  const sort = parsed.sort || variantConfig?.sort;

  try {
    let result: { metas: StremioMeta[] } | null = null;

    if (baseCatalogId === 'letterboxd-popular' && cfg.c.popular) {
      trackEvent('catalog_popular', undefined);
      result = await fetchPopularCatalogPublic(skip, showRatings, sort, includeGenre, decade);
    } else if (baseCatalogId === 'letterboxd-top250' && cfg.c.top250) {
      trackEvent('catalog_top250', undefined);
      result = await fetchTop250CatalogPublic(skip, showRatings, sort, includeGenre, decade);
    } else if (baseCatalogId === 'letterboxd-watchlist' && cfg.u && cfg.c.watchlist && memberId) {
      trackEvent('catalog_watchlist', undefined);
      result = await fetchWatchlistCatalogPublic(memberId, skip, showRatings, sort, includeGenre, decade);
    } else if (baseCatalogId === 'letterboxd-liked-films' && cfg.u && cfg.c.likedFilms && memberId) {
      trackEvent('catalog_liked', undefined);
      result = await fetchLikedFilmsCatalogPublic(memberId, skip, showRatings, sort, includeGenre, decade);
    } else if (baseCatalogId.startsWith('letterboxd-watchlist-')) {
      const username = baseCatalogId.replace('letterboxd-watchlist-', '');
      if (cfg.w?.includes(username)) {
        trackEvent('catalog_watchlist', undefined, { externalUsername: username });
        const extMemberId = await resolveMemberId(username);
        if (extMemberId) {
          result = await fetchWatchlistCatalogPublic(extMemberId, skip, showRatings, sort, includeGenre, decade);
        }
      }
    } else if (baseCatalogId.startsWith('letterboxd-list-')) {
      const listId = baseCatalogId.replace('letterboxd-list-', '');
      if (cfg.l.includes(listId)) {
        const listName = listNameCache.get(listId);
        trackEvent('catalog_list', undefined, { listId, ...(listName && { listName }) });
        result = await fetchListCatalogPublic(listId, skip, showRatings, sort, includeGenre, decade);
      }
    }

    if (!result) return { metas: [] };

    if (isShuffle) {
      result = { metas: shuffleArray(result.metas) };
    }

    return result;
  } catch (error) {
    logger.error({ error, catalogId }, 'Failed to fetch public catalog');
    return { metas: [] };
  }
}

export async function stremioRoutes(app: FastifyInstance) {
  // ═══════════════════════════════════════════════════════════════════════════
  // Poster Proxy: Rating badge overlay on poster images
  // ═══════════════════════════════════════════════════════════════════════════

  app.get(
    '/poster',
    { config: { rateLimit: false } },
    async (
      request: FastifyRequest<{
        Querystring: { url?: string; rating?: string };
      }>,
      reply
    ) => {
      const { url, rating: ratingStr } = request.query;

      if (!url || !ratingStr) {
        return reply.status(400).send({ error: 'Missing url or rating parameter' });
      }

      const rating = parseFloat(ratingStr);
      if (isNaN(rating) || rating < 0 || rating > 5) {
        return reply.status(400).send({ error: 'Rating must be between 0 and 5' });
      }

      // Only allow Letterboxd CDN URLs
      try {
        const parsed = new URL(url);
        if (!parsed.hostname.endsWith('.ltrbxd.com') && !parsed.hostname.endsWith('.letterboxd.com')) {
          return reply.status(400).send({ error: 'Invalid poster URL' });
        }
      } catch {
        return reply.status(400).send({ error: 'Invalid URL' });
      }

      try {
        const imageBuffer = await generateRatedPoster(url, rating);

        return reply
          .header('Content-Type', 'image/jpeg')
          .header('Cache-Control', 'public, max-age=3600')
          .send(imageBuffer);
      } catch (error) {
        logger.error({ error, url, rating }, 'Failed to generate rated poster');
        return reply.status(500).send({ error: 'Failed to generate poster' });
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Tier 1: Generic public catalogs (Popular + Top 250)
  // ═══════════════════════════════════════════════════════════════════════════

  app.get(
    '/catalog/movie/letterboxd-popular.json',
    async (_request, reply) => {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Content-Type', 'application/json');

      return await fetchPopularCatalogPublic(0, true);
    }
  );

  app.get(
    '/catalog/movie/letterboxd-popular/:extra.json',
    async (
      request: FastifyRequest<{ Params: { extra: string } }>,
      reply
    ) => {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Content-Type', 'application/json');

      const { skip, sort, isShuffle, includeGenre, decade } = parseCombinedFilter(request.params.extra);
      let result = await fetchPopularCatalogPublic(skip, true, sort, includeGenre, decade);
      if (isShuffle) result = { metas: shuffleArray(result.metas) };
      return result;
    }
  );

  app.get(
    '/catalog/movie/letterboxd-top250.json',
    async (_request, reply) => {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Content-Type', 'application/json');

      return await fetchTop250CatalogPublic(0, true);
    }
  );

  app.get(
    '/catalog/movie/letterboxd-top250/:extra.json',
    async (
      request: FastifyRequest<{ Params: { extra: string } }>,
      reply
    ) => {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Content-Type', 'application/json');

      const { skip, sort, isShuffle, includeGenre, decade } = parseCombinedFilter(request.params.extra);
      let result = await fetchTop250CatalogPublic(skip, true, sort, includeGenre, decade);
      if (isShuffle) result = { metas: shuffleArray(result.metas) };
      return result;
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Tier 2: Config-based public routes
  // ═══════════════════════════════════════════════════════════════════════════

  async function resolveListNames(listIds: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    await Promise.all(listIds.map(async (id) => {
      const cached = listNameCache.get(id);
      if (cached) {
        names.set(id, cached);
        return;
      }
      try {
        const list = await callWithAppToken((token) => rawGetList(token, id));
        listNameCache.set(id, list.name);
        names.set(id, list.name);
      } catch {
        // Fallback: keep ID as name
      }
    }));
    return names;
  }

  app.get(
    '/:config/manifest.json',
    async (
      request: FastifyRequest<{ Params: { config: string } }>,
      reply
    ) => {
      const cfg = decodeConfig(request.params.config);
      if (!cfg) {
        return reply.status(400).send({ error: 'Invalid config' });
      }

      trackTier1('manifest_view', cfg, request);

      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Content-Type', 'application/json');
      reply.header('Cache-Control', 'public, max-age=3600');

      let displayName: string | undefined;
      if (cfg.u) {
        try {
          const member = await callWithAppToken((token) => rawGetMember(token, cfg.u!));
          displayName = member.displayName || member.username;
        } catch {
          displayName = cfg.u;
        }
      }

      const listNames = cfg.l.length > 0 ? await resolveListNames(cfg.l) : undefined;

      // Resolve external watchlist display names
      let watchlistNames: Map<string, string> | undefined;
      if (cfg.w && cfg.w.length > 0) {
        watchlistNames = new Map<string, string>();
        await Promise.all(cfg.w.map(async (username) => {
          try {
            const member = await callWithAppToken((token) => rawGetMember(token, username));
            watchlistNames!.set(username, member.displayName || member.username);
          } catch {
            watchlistNames!.set(username, username);
          }
        }));
      }

      return generatePublicManifest(cfg, displayName, listNames, watchlistNames);
    }
  );

  app.get(
    '/:config/catalog/movie/:id.json',
    async (
      request: FastifyRequest<{ Params: { config: string; id: string } }>,
      reply
    ) => {
      const cfg = decodeConfig(request.params.config);
      if (!cfg) {
        return reply.status(400).send({ error: 'Invalid config' });
      }

      trackTier1(catalogIdToEvent(request.params.id), cfg, request, { catalog: request.params.id });

      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Content-Type', 'application/json');

      let memberId: string | null = null;
      if (cfg.u) {
        memberId = await resolveMemberId(cfg.u);
      }

      return await handlePublicCatalogRequest(cfg, request.params.id, undefined, memberId);
    }
  );

  app.get(
    '/:config/catalog/movie/:id/:extra.json',
    async (
      request: FastifyRequest<{ Params: { config: string; id: string; extra: string } }>,
      reply
    ) => {
      const cfg = decodeConfig(request.params.config);
      if (!cfg) {
        return reply.status(400).send({ error: 'Invalid config' });
      }

      trackTier1(catalogIdToEvent(request.params.id), cfg, request, { catalog: request.params.id });

      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Content-Type', 'application/json');

      let memberId: string | null = null;
      if (cfg.u) {
        memberId = await resolveMemberId(cfg.u);
      }

      return await handlePublicCatalogRequest(cfg, request.params.id, request.params.extra, memberId);
    }
  );

  // Meta Route: Tier 1 — pass-through Cinemeta (no auth required)
  // ═══════════════════════════════════════════════════════════════════════════

  app.get(
    '/:config/meta/movie/:imdbId.json',
    async (
      request: FastifyRequest<{ Params: { config: string; imdbId: string } }>,
      reply
    ) => {
      const { imdbId } = request.params;

      if (!IMDB_REGEX.test(imdbId)) {
        return reply.status(400).send({ error: 'Invalid IMDb ID' });
      }

      const cfg = decodeConfig(request.params.config);
      if (!cfg) {
        return reply.status(400).send({ error: 'Invalid config' });
      }

      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Content-Type', 'application/json');
      reply.header('Cache-Control', 'public, max-age=3600');

      const rawMeta = await getRawCinemetaMeta(imdbId);
      if (!rawMeta) {
        return { meta: null };
      }

      return { meta: rawMeta };
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Tier 3: User-authenticated routes
  // ═══════════════════════════════════════════════════════════════════════════

  app.get(
    '/stremio/:userId/manifest.json',
    async (
      request: FastifyRequest<{
        Params: { userId: string };
      }>,
      reply
    ) => {
      const { userId } = request.params;

      const user = findUserById(userId);
      if (!user) {
        logger.warn({ userId }, 'User not found for manifest');
        return reply.status(404).send({ error: 'User not found' });
      }

      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Content-Type', 'application/json');

      try {
        // Fetch user lists for dynamic manifest
        const lists = await fetchUserLists(user);
        const preferences = getUserPreferences(user);

        const manifest = generateDynamicManifest(
          {
            username: user.letterboxd_username,
            displayName: user.letterboxd_display_name,
          },
          lists,
          preferences
        );

        trackEvent('install', userId);

        logger.info(
          { username: user.letterboxd_username, listsCount: lists.length, hasPreferences: !!preferences },
          'Dynamic manifest generated'
        );

        return manifest;

      } catch (error) {
        // Fallback to static manifest if lists fetch fails
        logger.error({ error, userId }, 'Failed to fetch user lists, using static manifest');

        const manifest = generateManifest({
          username: user.letterboxd_username,
          displayName: user.letterboxd_display_name,
        });

        return manifest;
      }
    }
  );

  // Catalog without extra params
  app.get(
    '/stremio/:userId/catalog/:type/:id.json',
    async (
      request: FastifyRequest<{
        Params: { userId: string; type: string; id: string };
      }>,
      reply
    ) => {
      const { userId, type, id } = request.params;

      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Content-Type', 'application/json');

      try {
        return await handleCatalogRequest(userId, type, id);
      } catch {
        return reply.status(404).send({ error: 'User not found' });
      }
    }
  );

  // Catalog with extra params (skip, genre, etc.)
  app.get(
    '/stremio/:userId/catalog/:type/:id/:extra.json',
    async (
      request: FastifyRequest<{
        Params: { userId: string; type: string; id: string; extra: string };
      }>,
      reply
    ) => {
      const { userId, type, id, extra } = request.params;

      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Content-Type', 'application/json');

      try {
        return await handleCatalogRequest(userId, type, id, extra);
      } catch {
        return reply.status(404).send({ error: 'User not found' });
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Stream Route: Letterboxd info & actions as streams (cross-platform)
  // ═══════════════════════════════════════════════════════════════════════════

  app.get(
    '/stremio/:userId/stream/:type/:id.json',
    async (
      request: FastifyRequest<{
        Params: { userId: string; type: string; id: string };
      }>,
      reply
    ) => {
      const { userId, type, id } = request.params;

      const user = findUserById(userId);
      if (!user) {
        return reply.status(404).send({ streams: [] });
      }

      logger.info({ type, id, username: user.letterboxd_username }, 'Stream request');

      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Content-Type', 'application/json');

      if (type !== 'movie') {
        return { streams: [] };
      }

      const imdbId = id.replace(/\.json$/, '');

      try {
        trackEvent('stream', userId, { imdbId });
        const client = await createClientForUser(user);
        const preferences = getUserPreferences(user);
        const showActions = preferences?.showActions !== false;
        const streams = await buildLetterboxdStreams(client, imdbId, user.id, showActions);

        logger.info({ imdbId, streamCount: streams.length }, 'Letterboxd streams returned');
        return { streams };

      } catch (error) {
        logger.error({ error, userId, imdbId }, 'Failed to fetch streams');
        return { streams: [] };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Meta Route: Pass-through Cinemeta + Letterboxd poster badge (Tier 2 only)
  // ═══════════════════════════════════════════════════════════════════════════

  app.get(
    '/stremio/:userId/meta/movie/:imdbId.json',
    async (
      request: FastifyRequest<{ Params: { userId: string; imdbId: string } }>,
      reply
    ) => {
      const { userId, imdbId } = request.params;

      if (!IMDB_REGEX.test(imdbId)) {
        return reply.status(400).send({ error: 'Invalid IMDb ID' });
      }

      const user = findUserById(userId);
      if (!user) {
        return reply.status(404).send({ meta: null });
      }

      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Content-Type', 'application/json');

      // 1. Fetch raw Cinemeta meta (all fields preserved)
      const rawMeta = await getRawCinemetaMeta(imdbId);
      if (!rawMeta) {
        return { meta: null };
      }

      // 2. Try to enhance with Letterboxd poster badge + popular reviews
      const meta: Record<string, unknown> = { ...rawMeta };
      try {
        const client = await createClientForUser(user);
        const letterboxdResult = await findFilmByImdb(client, imdbId);
        if (letterboxdResult) {
          const { letterboxdFilmId } = letterboxdResult;

          // Poster badge (non-critical)
          const metaPreferences = getUserPreferences(user);
          const showRatings = metaPreferences?.showRatings !== false;
          try {
            if (showRatings) {
              const ratingData = await getFilmRatingData(client, letterboxdFilmId);
              if (ratingData.communityRating !== null && rawMeta['poster']) {
                meta['poster'] = `${serverConfig.publicUrl}/poster?url=${encodeURIComponent(rawMeta['poster'] as string)}&rating=${ratingData.communityRating.toFixed(1)}`;
              }
            }
          } catch {
            // Rating lookup failed — skip badge
          }

          // Popular reviews as a distinct links section (appears before Summary in Stremio)
          const showReviews = metaPreferences?.showReviews !== false;
          if (showReviews) {
            try {
              const reviewsText = await getPopularReviewsText(client, letterboxdFilmId);
              if (reviewsText) {
                const existingLinks = (meta['links'] as Array<{ name: string; category: string; url: string }>) || [];
                const letterboxdUrl = `https://letterboxd.com/film/${letterboxdFilmId}/reviews/`;
                const reviewLinks = reviewsText.split('\n\n').map(line => ({
                  name: line,
                  category: 'Letterboxd Popular Reviews',
                  url: letterboxdUrl,
                }));
                meta['links'] = [...existingLinks, ...reviewLinks];
              }
            } catch {
              // Reviews fetch failed — skip
            }
          }
        }
      } catch {
        // Non-critical — fall through to raw Cinemeta response
      }

      return { meta };
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Action Routes: Toggle watched/liked/watchlist on Letterboxd
  // ═══════════════════════════════════════════════════════════════════════════

  app.get(
    '/action/:userId/:action/:filmId',
    {
      schema: { params: actionParamsSchema },
    },
    async (
      request: FastifyRequest<{
        Params: { userId: string; action: string; filmId: string };
        Querystring: { set?: string; imdb?: string; tok?: string };
      }>,
      reply
    ) => {
      const { userId, action, filmId } = request.params;
      const tok = request.query.tok;

      if (!tok || !verifyAction(userId, filmId, action, tok)) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      const setValue = request.query.set === 'true';
      const rawImdbId = request.query.imdb;
      const imdbId = rawImdbId && IMDB_REGEX.test(rawImdbId) ? rawImdbId : undefined;

      const user = findUserById(userId);
      if (!user) {
        return sendHtml(reply, `
          <html>
            <head><title>Error</title></head>
            <body style="font-family: system-ui; background: #18181b; color: #fafafa; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
              <div style="text-align: center;">
                <h1 style="color: #ef4444;">User not found</h1>
                <p>Please re-install the addon.</p>
              </div>
            </body>
          </html>
        `, 404);
      }

      logger.info({ userId, action, filmId, setValue, imdbId }, 'Action request');

      try {
        const actionEventMap: Record<string, 'action_watched' | 'action_liked' | 'action_watchlist'> = {
          watched: 'action_watched',
          liked: 'action_liked',
          watchlist: 'action_watchlist',
        };
        const eventType = actionEventMap[action];
        if (eventType) trackEvent(eventType, userId, { filmId, setValue, ...(imdbId && { imdbId }) });

        const client = await createClientForUser(user);

        // Build update object based on action
        const update: FilmRelationshipUpdate = {};
        if (action === 'watched') update.watched = setValue;
        if (action === 'liked') update.liked = setValue;
        if (action === 'watchlist') update.inWatchlist = setValue;

        // Perform the update
        const result = await client.updateFilmRelationship(filmId, update);

        // Invalidate user catalog cache so next request reflects the change
        invalidateUserCatalogs(userId);

        // Get action labels for response
        const actionLabels: Record<string, { active: string; inactive: string }> = {
          watched: { active: 'Marked as watched', inactive: 'Removed from watched' },
          liked: { active: 'Liked', inactive: 'Unliked' },
          watchlist: { active: 'Added to watchlist', inactive: 'Removed from watchlist' },
        };

        const label = actionLabels[action]!;
        const message = setValue ? label.active : label.inactive;

        // Build Stremio deep link for redirect
        const stremioDeepLink = imdbId ? `stremio:///detail/movie/${imdbId}` : null;

        // Build status line
        const statusParts: string[] = [];
        if (result.data.watched) statusParts.push('Watched');
        if (result.data.liked) statusParts.push('Liked');
        if (result.data.inWatchlist) statusParts.push('In Watchlist');
        const statusLine = statusParts.length > 0 ? statusParts.join(' · ') : '';

        // Return success page with auto-redirect to Stremio
        return sendHtml(reply, `
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="UTF-8">
              <title>${message}</title>
              <meta name="viewport" content="width=device-width, initial-scale=1">
              ${stremioDeepLink ? `<meta http-equiv="refresh" content="1;url=${stremioDeepLink}">` : ''}
            </head>
            <body style="font-family: system-ui, -apple-system, sans-serif; background: #18181b; color: #fafafa; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
              <div style="text-align: center; padding: 2rem;">
                <p style="font-size: 2rem; margin: 0 0 1rem 0; color: #22c55e;">&#10003;</p>
                <h1 style="color: #fafafa; margin: 0 0 0.5rem 0; font-size: 1.25rem; font-weight: 500;">${message}</h1>
                <p style="color: #71717a; margin: 0; font-size: 0.875rem;">Returning to Stremio...</p>
                ${statusLine ? `<p style="color: #52525b; font-size: 0.75rem; margin-top: 1.5rem;">${statusLine}</p>` : ''}
                ${stremioDeepLink ? `
                <p style="margin-top: 1.5rem;">
                  <a href="${stremioDeepLink}" style="color: #71717a; font-size: 0.75rem; text-decoration: none;">Click here if not redirected</a>
                </p>
                ` : ''}
              </div>
            </body>
            ${stremioDeepLink ? `
            <script>
              setTimeout(function() {
                window.location.href = "${stremioDeepLink}";
              }, 800);
            </script>
            ` : ''}
          </html>
        `);

      } catch (error) {
        logger.error({ error, userId, action, filmId }, 'Failed to perform action');
        return sendHtml(reply, `
          <html>
            <head><title>Error</title></head>
            <body style="font-family: system-ui; background: #18181b; color: #fafafa; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
              <div style="text-align: center;">
                <h1 style="color: #ef4444;">Action failed</h1>
                <p style="color: #a1a1aa;">Could not update Letterboxd. Please try again.</p>
              </div>
            </body>
          </html>
        `, 500);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Rating Page: Show rating selection UI
  // ═══════════════════════════════════════════════════════════════════════════

  app.get(
    '/action/:userId/rate/:filmId',
    {
      schema: { params: rateParamsSchema },
    },
    async (
      request: FastifyRequest<{
        Params: { userId: string; filmId: string };
        Querystring: { imdb?: string; current?: string; name?: string; tok?: string };
      }>,
      reply
    ) => {
      const { userId, filmId } = request.params;
      const tok = request.query.tok;

      if (!tok || !verifyAction(userId, filmId, 'rate', tok)) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      const rawImdbId = request.query.imdb;
      const imdbId = rawImdbId && IMDB_REGEX.test(rawImdbId) ? rawImdbId : undefined;
      const currentRating = request.query.current ? parseFloat(request.query.current) : null;
      const filmName = request.query.name || 'this film';

      const user = findUserById(userId);
      if (!user) {
        return sendHtml(reply, `
          <html>
            <head><title>Error</title></head>
            <body style="font-family: system-ui; background: #18181b; color: #fafafa; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
              <div style="text-align: center;">
                <h1 style="color: #ef4444;">User not found</h1>
              </div>
            </body>
          </html>
        `, 404);
      }

      // Sanitize film name for HTML output
      const safeFilmName = filmName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

      const submitBase = `/action/${userId}/rate/${filmId}/submit?imdb=${imdbId || ''}&tok=${tok}&rating=`;

      const removeButton = currentRating ? `
        <div style="margin-top: 1.5rem; padding-top: 1.5rem; border-top: 1px solid #3f3f46;">
          <a href="${submitBase}remove" class="remove"
             style="display: inline-block; padding: 0.5rem 1rem;
                    background: transparent; color: #a1a1aa;
                    border-radius: 0.375rem; text-decoration: none; font-size: 0.875rem;
                    border: 1px solid #3f3f46; transition: all 0.15s;">
            Remove rating
          </a>
        </div>
      ` : '';

      const stremioDeepLink = imdbId ? `stremio:///detail/movie/${imdbId}` : null;

      return sendHtml(reply, `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <title>Rate ${safeFilmName}</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
              .stars { display: inline-flex; gap: 0.25rem; cursor: pointer; padding: 0.5rem 0; }
              .star {
                font-size: 2.75rem;
                position: relative;
                -webkit-user-select: none;
                user-select: none;
                line-height: 1;
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                background-clip: text;
                background: #3f3f46;
                transition: transform 0.15s;
              }
              .remove:hover { color: #fafafa !important; border-color: #71717a !important; }
              a.back:hover { color: #fafafa !important; }
            </style>
          </head>
          <body style="font-family: system-ui, -apple-system, sans-serif; background: #18181b; color: #fafafa; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 1rem;">
            <div style="text-align: center; max-width: 420px; width: 100%;">
              <h1 style="margin: 0 0 0.75rem 0; font-size: 1.25rem; font-weight: 500; color: #fafafa;">Rate <em>${safeFilmName}</em></h1>
              <div class="stars" id="stars">
                <span class="star" data-r="1">&#9733;</span>
                <span class="star" data-r="2">&#9733;</span>
                <span class="star" data-r="3">&#9733;</span>
                <span class="star" data-r="4">&#9733;</span>
                <span class="star" data-r="5">&#9733;</span>
              </div>
              ${removeButton}
              ${stremioDeepLink ? `
              <p style="margin-top: 2rem;">
                <a href="${stremioDeepLink}" class="back" style="color: #71717a; font-size: 0.875rem; text-decoration: none; transition: color 0.15s;">Back to Stremio</a>
              </p>
              ` : ''}
            </div>
          </body>
          <script>
            (function() {
              var stars = document.querySelectorAll('.star');
              var current = ${currentRating ?? 0};
              var base = '${submitBase}';

              function fillStar(star, pct, color) {
                var c = color || '#f59e0b';
                if (pct >= 100) {
                  star.style.background = c;
                } else if (pct <= 0) {
                  star.style.background = '#3f3f46';
                } else {
                  star.style.background = 'linear-gradient(90deg, ' + c + ' ' + pct + '%, #3f3f46 ' + pct + '%)';
                }
                star.style.webkitBackgroundClip = 'text';
                star.style.webkitTextFillColor = 'transparent';
                star.style.backgroundClip = 'text';
              }

              function render(rating, color) {
                stars.forEach(function(s) {
                  var r = parseInt(s.getAttribute('data-r'));
                  var pct;
                  if (rating >= r) { pct = 100; }
                  else if (rating >= r - 0.5) { pct = 50; }
                  else { pct = 0; }
                  fillStar(s, pct, color);
                  s.style.transform = rating > 0 && r <= Math.ceil(rating) ? 'scale(1.1)' : 'scale(1)';
                });
              }

              function getRating(star, e) {
                var rect = star.getBoundingClientRect();
                var isLeft = (e.clientX - rect.left) < (rect.width / 2);
                var r = parseInt(star.getAttribute('data-r'));
                return isLeft ? r - 0.5 : r;
              }

              render(current, '#f59e0b');

              stars.forEach(function(s) {
                s.addEventListener('mousemove', function(e) {
                  var rating = getRating(s, e);
                  render(rating, '#fbbf24');
                });
                s.addEventListener('click', function(e) {
                  var rating = getRating(s, e);
                  window.location.href = base + rating;
                });
              });

              document.getElementById('stars').addEventListener('mouseleave', function() {
                render(current, '#f59e0b');
              });
            })();
          </script>
        </html>
      `);
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Rating Submit: Actually submit the rating
  // ═══════════════════════════════════════════════════════════════════════════

  app.get(
    '/action/:userId/rate/:filmId/submit',
    {
      schema: { params: rateParamsSchema },
    },
    async (
      request: FastifyRequest<{
        Params: { userId: string; filmId: string };
        Querystring: { rating: string; imdb?: string; tok?: string };
      }>,
      reply
    ) => {
      const { userId, filmId } = request.params;
      const tok = request.query.tok;

      if (!tok || !verifyAction(userId, filmId, 'rate', tok)) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      const { rating: ratingStr } = request.query;
      const rawImdbId = request.query.imdb;
      const imdbId = rawImdbId && IMDB_REGEX.test(rawImdbId) ? rawImdbId : undefined;

      const user = findUserById(userId);
      if (!user) {
        return sendHtml(reply, `
          <html>
            <head><title>Error</title></head>
            <body style="font-family: system-ui; background: #18181b; color: #fafafa; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
              <div style="text-align: center;">
                <h1 style="color: #ef4444;">User not found</h1>
              </div>
            </body>
          </html>
        `, 404);
      }

      const isRemove = ratingStr === 'remove';
      const rating = isRemove ? null : parseFloat(ratingStr);

      logger.info({ userId, filmId, rating, isRemove, imdbId }, 'Rating submit request');
      trackEvent('action_rate', userId, { filmId, rating, isRemove, ...(imdbId && { imdbId }) });

      try {
        const client = await createClientForUser(user);

        const update: FilmRelationshipUpdate = {
          rating: isRemove ? null : rating,
        };

        await client.updateFilmRelationship(filmId, update);

        // Invalidate user catalog cache so next request reflects the change
        invalidateUserCatalogs(userId);

        const message = isRemove ? 'Rating removed' : `Rated &#9733; ${rating!.toFixed(1)}`;
        const stremioDeepLink = imdbId ? `stremio:///detail/movie/${imdbId}` : null;

        return sendHtml(reply, `
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="UTF-8">
              <title>${message}</title>
              <meta name="viewport" content="width=device-width, initial-scale=1">
              ${stremioDeepLink ? `<meta http-equiv="refresh" content="1;url=${stremioDeepLink}">` : ''}
            </head>
            <body style="font-family: system-ui, -apple-system, sans-serif; background: #18181b; color: #fafafa; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
              <div style="text-align: center; padding: 2rem;">
                <p style="font-size: 2rem; margin: 0 0 1rem 0; color: #22c55e;">&#10003;</p>
                <h1 style="color: #fafafa; margin: 0 0 0.5rem 0; font-size: 1.25rem; font-weight: 500;">${message}</h1>
                <p style="color: #71717a; margin: 0; font-size: 0.875rem;">Returning to Stremio...</p>
                ${stremioDeepLink ? `
                <p style="margin-top: 1.5rem;">
                  <a href="${stremioDeepLink}" style="color: #71717a; font-size: 0.75rem; text-decoration: none;">Click here if not redirected</a>
                </p>
                ` : ''}
              </div>
            </body>
            ${stremioDeepLink ? `
            <script>
              setTimeout(function() {
                window.location.href = "${stremioDeepLink}";
              }, 800);
            </script>
            ` : ''}
          </html>
        `);

      } catch (error) {
        logger.error({ error, userId, filmId, rating }, 'Failed to submit rating');
        return sendHtml(reply, `
          <html>
            <head><title>Error</title></head>
            <body style="font-family: system-ui; background: #18181b; color: #fafafa; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
              <div style="text-align: center;">
                <h1 style="color: #ef4444;">Rating failed</h1>
                <p style="color: #a1a1aa;">Could not update Letterboxd. Please try again.</p>
              </div>
            </body>
          </html>
        `, 500);
      }
    }
  );
}
