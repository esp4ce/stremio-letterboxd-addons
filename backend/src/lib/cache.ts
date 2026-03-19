import { LRUCache } from 'lru-cache';
import { cacheConfig } from '../config/index.js';

export interface CacheOptions {
  maxSize?: number;
  ttl?: number;
}

export class Coalescer<T> {
  private inflight = new Map<string, Promise<T>>();

  async run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  get size() { return this.inflight.size; }
}

export function createCache<T extends NonNullable<unknown>>(options: CacheOptions = {}) {
  return new LRUCache<string, T>({
    max: options.maxSize ?? cacheConfig.maxSize,
    ttl: options.ttl ?? cacheConfig.filmTtl,
  });
}

export interface CachedFilm {
  id: string;
  name: string;
  releaseYear?: number;
  poster?: string;
  imdbId?: string;
  tmdbId?: string;
}

export interface CachedRating {
  filmId: string;
  userRating: number | null;
  watched: boolean;
  liked: boolean;
  inWatchlist: boolean;
  communityRating: number | null;
  communityRatings: number;
}

export const filmCache = createCache<CachedFilm>({
  ttl: cacheConfig.filmTtl,
});

export const userRatingCache = createCache<CachedRating>({
  ttl: 5 * 60 * 1000, // 5 minutes for user-specific data
});

// Full film lookup result cache (avoids re-fetching on cache hit)
export interface FilmLookupCacheEntry {
  letterboxdFilmId: string;
  film: unknown; // LetterboxdFilm — stored as unknown to avoid circular import
}
export const filmLookupCache = createCache<FilmLookupCacheEntry>({
  maxSize: 1000,
  ttl: 60 * 60 * 1000, // 1 hour
});

// IMDb ID → Letterboxd ID mapping cache (populated from catalog fetches)
export const imdbToLetterboxdCache = createCache<string>({
  ttl: 60 * 60 * 1000, // 1 hour TTL
});

// User lists cache (short TTL since lists can change)
export const userListsCache = createCache<{
  lists: Array<{ id: string; name: string; filmCount: number }>;
}>({
  ttl: 5 * 60 * 1000, // 5 minutes
});

// Cinemeta film data (from Stremio's Cinemeta addon)
export interface CinemetaFilmData {
  name: string;
  year?: number;
  poster?: string;
  background?: string;
  genres?: string[];
  director?: string[];
  cast?: string[];
  writer?: string[];
  runtime?: string;
  description?: string;
  trailers?: Array<{ source: string; type: string }>;
  releaseInfo?: string;
  imdbRating?: string;
}

// Cinemeta cache (long TTL since this data rarely changes)
export const cinemetaCache = createCache<CinemetaFilmData>({
  ttl: 60 * 60 * 1000, // 1 hour
});


// Raw Cinemeta meta cache — stores the full unfiltered meta object for pass-through
export const cinemetaRawCache = createCache<Record<string, unknown>>({
  ttl: 60 * 60 * 1000, // 1 hour
});

// ── Public catalog caches ────────────────────────────────────────────────────

import type { StremioMeta } from '../modules/stremio/catalog.service.js';

// Popular This Week cache (24 hours - changes weekly)
export const popularCatalogCache = createCache<{ metas: StremioMeta[] }>({
  ttl: 24 * 60 * 60 * 1000,
});

// Top 250 cache (24 hours - changes very rarely)
export const top250CatalogCache = createCache<{ metas: StremioMeta[] }>({
  ttl: 24 * 60 * 60 * 1000,
});

// Username → memberId mapping (24 hours - never changes)
export const memberIdCache = createCache<string>({
  ttl: 24 * 60 * 60 * 1000,
});

// Public watchlist cache (configurable TTL, default 5 min)
export const publicWatchlistCache = createCache<{ metas: StremioMeta[] }>({
  ttl: cacheConfig.watchlistTtl,
});

// Public list catalog cache (5 minutes)
export const publicListCache = createCache<{ metas: StremioMeta[] }>({
  ttl: 5 * 60 * 1000,
});

// List ID → name cache (24 hours - list names rarely change)
export const listNameCache = createCache<string>({
  ttl: 24 * 60 * 60 * 1000,
});

// Liked films cache (5 minutes - user may update frequently)
export const likedFilmsCache = createCache<{ metas: StremioMeta[] }>({
  ttl: 5 * 60 * 1000,
});

// Poster cache (from poster.service.ts - imported dynamically to avoid circular deps)
export const posterCache = createCache<Buffer>({
  maxSize: 500,
  ttl: 60 * 60 * 1000,
});

// ── User client cache (Tier 2 token reuse) ─────────────────────────────────

import type { AuthenticatedClient } from '../modules/letterboxd/letterboxd.client.js';

export const userClientCache = createCache<{ client: AuthenticatedClient; expiresAt: number }>({
  maxSize: 500,
  ttl: 30 * 60 * 1000, // 30min max, expiresAt checked manually
});

// ── Per-user catalog cache (Tier 2) ────────────────────────────────────────

export const userCatalogCache = createCache<{ metas: StremioMeta[] }>({
  maxSize: 500,
  ttl: 5 * 60 * 1000, // 5min — invalidateUserCatalogs() covers manual changes
});

// Watched IMDb IDs per user (for "Not Watched" filter)
export const watchedImdbCache = createCache<{ ids: Set<string> }>({
  maxSize: 200,
  ttl: 5 * 60 * 1000, // 5 minutes
});

// Film reviews formatted text cache
export const filmReviewsCache = createCache<string>({
  maxSize: 500,
  ttl: 60 * 60 * 1000, // 1 hour
});

// Recommendations cache (expensive to compute, stable results)
export const recommendationCache = createCache<{ metas: StremioMeta[] }>({
  maxSize: 200,
  ttl: 6 * 60 * 60 * 1000, // 6h
});

// TMDB ID → IMDb ID mapping (never changes)
export const tmdbToImdbCache = createCache<string>({
  maxSize: 10_000,
  ttl: 7 * 24 * 60 * 60 * 1000, // 7 days
});

// Track cache keys per user for efficient invalidation (LRU doesn't support prefix scan)
const userCatalogKeys = new Map<string, Set<string>>();

/**
 * Check user catalog cache, returning paginated metas on hit or undefined on miss.
 */
export function getUserCatalogCached(
  cacheKey: string,
  skip: number,
  pageSize: number,
): { metas: StremioMeta[] } | undefined {
  const cached = userCatalogCache.get(cacheKey);
  if (!cached) return undefined;
  cacheMetrics.catalogHits++;
  return { metas: cached.metas.slice(skip, skip + pageSize) };
}

/**
 * Store full catalog in user cache and return the paginated slice.
 */
export function setUserCatalog(
  userId: string,
  cacheKey: string,
  allMetas: StremioMeta[],
  skip: number,
  pageSize: number,
): { metas: StremioMeta[] } {
  cacheMetrics.catalogMisses++;
  userCatalogCache.set(cacheKey, { metas: allMetas });
  let keys = userCatalogKeys.get(userId);
  if (!keys) {
    keys = new Set();
    userCatalogKeys.set(userId, keys);
  }
  keys.add(cacheKey);
  return { metas: allMetas.slice(skip, skip + pageSize) };
}

export function invalidateUserCatalogs(userId: string) {
  const keys = userCatalogKeys.get(userId);
  if (!keys) return;
  for (const key of keys) {
    userCatalogCache.delete(key);
  }
  userCatalogKeys.delete(userId);
}

// Periodically prune stale entries from userCatalogKeys (keys whose cache entries expired)
setInterval(() => {
  for (const [userId, keys] of userCatalogKeys) {
    for (const key of keys) {
      if (!userCatalogCache.has(key)) keys.delete(key);
    }
    if (keys.size === 0) userCatalogKeys.delete(userId);
  }
}, 5 * 60 * 1000); // Every 5 minutes

// ── Cache metrics (hit/miss counters) ────────────────────────────────────────

export const cacheMetrics = {
  catalogHits: 0,
  catalogMisses: 0,
  tokenHits: 0,
  tokenMisses: 0,
};

export function getCacheMetrics() {
  const catalogTotal = cacheMetrics.catalogHits + cacheMetrics.catalogMisses;
  const tokenTotal = cacheMetrics.tokenHits + cacheMetrics.tokenMisses;
  return {
    catalog: {
      hits: cacheMetrics.catalogHits,
      misses: cacheMetrics.catalogMisses,
      hitRate: catalogTotal > 0 ? parseFloat((cacheMetrics.catalogHits / catalogTotal * 100).toFixed(1)) : 0,
    },
    token: {
      hits: cacheMetrics.tokenHits,
      misses: cacheMetrics.tokenMisses,
      hitRate: tokenTotal > 0 ? parseFloat((cacheMetrics.tokenHits / tokenTotal * 100).toFixed(1)) : 0,
    },
  };
}

// ── Cache stats export ───────────────────────────────────────────────────────

export interface CacheStats {
  [key: string]: { size: number; max: number };
}

export function getCacheStats(): CacheStats {
  return {
    film: { size: filmCache.size, max: filmCache.max },
    filmLookup: { size: filmLookupCache.size, max: filmLookupCache.max },
    userRating: { size: userRatingCache.size, max: userRatingCache.max },
    imdbToLetterboxd: { size: imdbToLetterboxdCache.size, max: imdbToLetterboxdCache.max },
    userLists: { size: userListsCache.size, max: userListsCache.max },
    cinemeta: { size: cinemetaCache.size, max: cinemetaCache.max },
    popularCatalog: { size: popularCatalogCache.size, max: popularCatalogCache.max },
    top250Catalog: { size: top250CatalogCache.size, max: top250CatalogCache.max },
    memberId: { size: memberIdCache.size, max: memberIdCache.max },
    publicWatchlist: { size: publicWatchlistCache.size, max: publicWatchlistCache.max },
    publicList: { size: publicListCache.size, max: publicListCache.max },
    listName: { size: listNameCache.size, max: listNameCache.max },
    likedFilms: { size: likedFilmsCache.size, max: likedFilmsCache.max },
    poster: { size: posterCache.size, max: posterCache.max },
    userClient: { size: userClientCache.size, max: userClientCache.max },
    userCatalog: { size: userCatalogCache.size, max: userCatalogCache.max },
    watchedImdb: { size: watchedImdbCache.size, max: watchedImdbCache.max },
    filmReviews: { size: filmReviewsCache.size, max: filmReviewsCache.max },
    recommendation: { size: recommendationCache.size, max: recommendationCache.max },
    tmdbToImdb: { size: tmdbToImdbCache.size, max: tmdbToImdbCache.max },
  };
}
