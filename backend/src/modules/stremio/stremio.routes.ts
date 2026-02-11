import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  findUserById,
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
} from '../letterboxd/letterboxd.client.js';
import { generateManifest, generateDynamicManifest } from './stremio.service.js';
import {
  transformWatchlistToMetas,
  transformLogEntriesToMetas,
  transformActivityToMetas,
  transformListEntriesToMetas,
  cacheFilmMapping,
  StremioMeta,
} from './catalog.service.js';
import { buildLetterboxdStreams } from './meta.service.js';
import { createChildLogger } from '../../lib/logger.js';
import { userListsCache } from '../../lib/cache.js';
import { trackEvent } from '../../lib/metrics.js';

const logger = createChildLogger('stremio-routes');

const IMDB_REGEX = /^tt\d{1,10}$/;

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

/**
 * Create authenticated client for a user
 */
async function createClientForUser(user: User): Promise<AuthenticatedClient> {
  const refreshToken = getDecryptedRefreshToken(user);
  const tokens = await refreshAccessToken(refreshToken);

  // Update stored refresh token if it changed
  if (tokens.refresh_token !== refreshToken) {
    updateUser(user.id, {
      refreshToken: tokens.refresh_token,
      tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    });
  }

  return createAuthenticatedClient(
    tokens.access_token,
    tokens.refresh_token,
    user.letterboxd_id,
    (newTokens) => {
      updateUser(user.id, {
        refreshToken: newTokens.refresh_token,
        tokenExpiresAt: new Date(Date.now() + newTokens.expires_in * 1000),
      });
    }
  );
}

/**
 * Fetch watchlist and return Stremio metas with pagination
 */
async function fetchWatchlistCatalog(
  user: User,
  skip: number = 0
): Promise<{ metas: StremioMeta[] }> {
  const client = await createClientForUser(user);

  // Fetch all pages of the watchlist
  const allFilms: WatchlistFilm[] = [];
  let cursor: string | undefined;
  let page = 0;

  do {
    page++;
    const watchlist = await client.getWatchlist({ perPage: 100, cursor });
    logger.info({ page, itemsCount: watchlist.items.length, hasCursor: !!watchlist.cursor }, 'Watchlist page fetched');
    allFilms.push(...watchlist.items);
    cursor = watchlist.cursor;
  } while (cursor && page < 10); // Safety limit

  const allMetas = transformWatchlistToMetas(allFilms);

  // Cache IMDb→Letterboxd mappings for meta endpoint
  for (const film of allFilms) {
    cacheFilmMapping(film);
  }

  // Apply skip for Stremio pagination
  const metas = skip > 0 ? allMetas.slice(skip) : allMetas;

  logger.info(
    { total: allMetas.length, skip, returned: metas.length, username: user.letterboxd_username },
    'Watchlist fetched'
  );

  return { metas };
}

/**
 * Fetch diary (recent activity) and return Stremio metas with pagination
 */
async function fetchDiaryCatalog(
  user: User,
  skip: number = 0
): Promise<{ metas: StremioMeta[] }> {
  const client = await createClientForUser(user);

  // Fetch log entries (diary)
  const allEntries: LogEntry[] = [];
  let cursor: string | undefined;
  let page = 0;

  do {
    page++;
    const response = await client.getMemberLogEntries({ perPage: 100, cursor });
    logger.info({ page, itemsCount: response.items.length, hasCursor: !!response.cursor }, 'Diary page fetched');
    allEntries.push(...response.items);
    cursor = response.cursor;
  } while (cursor && page < 5); // Limit to 500 entries

  const allMetas = transformLogEntriesToMetas(allEntries);

  // Apply skip for Stremio pagination
  const metas = skip > 0 ? allMetas.slice(skip) : allMetas;

  logger.info(
    { total: allMetas.length, skip, returned: metas.length, username: user.letterboxd_username },
    'Diary fetched'
  );

  return { metas };
}

/**
 * Fetch friends activity and return Stremio metas
 */
async function fetchFriendsCatalog(
  user: User,
  skip: number = 0
): Promise<{ metas: StremioMeta[] }> {
  const client = await createClientForUser(user);

  // Fetch activity feed (includes own + friends activity)
  const allItems: ActivityItem[] = [];
  let nextStart: string | undefined;
  let page = 0;

  do {
    page++;
    const response = await client.getFriendsActivity({ perPage: 100, start: nextStart });
    logger.info({ page, itemsCount: response.items.length, hasNext: !!response.next }, 'Friends activity page fetched');
    allItems.push(...response.items);
    // next is like "start=10982004056"
    nextStart = response.next?.replace('start=', '');
  } while (nextStart && page < 3); // Limit to 300 entries

  // Transform to metas, filtering out own activity
  const allMetas = transformActivityToMetas(allItems, user.letterboxd_id);

  // Apply skip for Stremio pagination
  const metas = skip > 0 ? allMetas.slice(skip) : allMetas;

  logger.info(
    { total: allMetas.length, skip, returned: metas.length, username: user.letterboxd_username },
    'Friends activity fetched'
  );

  return { metas };
}

/**
 * Fetch a specific list's films and return Stremio metas
 */
async function fetchListCatalog(
  user: User,
  listId: string,
  skip: number = 0
): Promise<{ metas: StremioMeta[] }> {
  const client = await createClientForUser(user);

  // Fetch list entries
  const allEntries: ListEntry[] = [];
  let cursor: string | undefined;
  let page = 0;

  do {
    page++;
    const response = await client.getListEntries(listId, { perPage: 100, cursor });
    logger.info({ page, listId, itemsCount: response.items.length, hasCursor: !!response.cursor }, 'List page fetched');
    allEntries.push(...response.items);
    cursor = response.cursor;
  } while (cursor && page < 10); // Safety limit

  const allMetas = transformListEntriesToMetas(allEntries);

  // Cache IMDb→Letterboxd mappings
  for (const entry of allEntries) {
    cacheFilmMapping(entry.film);
  }

  // Apply skip for Stremio pagination
  const metas = skip > 0 ? allMetas.slice(skip) : allMetas;

  logger.info(
    { total: allMetas.length, skip, returned: metas.length, listId, username: user.letterboxd_username },
    'List fetched'
  );

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

  const params = parseExtra(extra);
  const skip = params['skip'] ? parseInt(params['skip'], 10) : 0;

  try {
    if (catalogId === 'letterboxd-watchlist') {
      trackEvent('catalog_watchlist', userId);
      return await fetchWatchlistCatalog(user, skip);
    }

    if (catalogId === 'letterboxd-diary') {
      trackEvent('catalog_diary', userId);
      return await fetchDiaryCatalog(user, skip);
    }

    if (catalogId === 'letterboxd-friends') {
      trackEvent('catalog_friends', userId);
      return await fetchFriendsCatalog(user, skip);
    }

    // Handle custom lists (letterboxd-list-{listId})
    if (catalogId.startsWith('letterboxd-list-')) {
      const listId = catalogId.replace('letterboxd-list-', '');
      trackEvent('catalog_list', userId, { listId });
      return await fetchListCatalog(user, listId, skip);
    }

    logger.warn({ catalogId }, 'Unknown catalog requested');
    return { metas: [] };

  } catch (error) {
    logger.error({ error, userId, catalogId }, 'Failed to fetch catalog');
    return { metas: [] };
  }
}

export async function stremioRoutes(app: FastifyInstance) {
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
        const streams = await buildLetterboxdStreams(client, imdbId, user.id);

        logger.info({ imdbId, streamCount: streams.length }, 'Letterboxd streams returned');
        return { streams };

      } catch (error) {
        logger.error({ error, userId, imdbId }, 'Failed to fetch streams');
        return { streams: [] };
      }
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
        Querystring: { set?: string; imdb?: string };
      }>,
      reply
    ) => {
      const { userId, action, filmId } = request.params;
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
        if (eventType) trackEvent(eventType, userId, { filmId, setValue });

        const client = await createClientForUser(user);

        // Build update object based on action
        const update: FilmRelationshipUpdate = {};
        if (action === 'watched') update.watched = setValue;
        if (action === 'liked') update.liked = setValue;
        if (action === 'watchlist') update.inWatchlist = setValue;

        // Perform the update
        const result = await client.updateFilmRelationship(filmId, update);


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
        Querystring: { imdb?: string; current?: string; name?: string };
      }>,
      reply
    ) => {
      const { userId, filmId } = request.params;
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

      const submitBase = `/action/${userId}/rate/${filmId}/submit?imdb=${imdbId || ''}&rating=`;

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
        Querystring: { rating: string; imdb?: string };
      }>,
      reply
    ) => {
      const { userId, filmId } = request.params;
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
      trackEvent('action_rate', userId, { filmId, rating, isRemove });

      try {
        const client = await createClientForUser(user);

        const update: FilmRelationshipUpdate = {
          rating: isRemove ? null : rating,
        };

        await client.updateFilmRelationship(filmId, update);


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
