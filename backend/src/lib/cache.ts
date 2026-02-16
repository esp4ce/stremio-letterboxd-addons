import { LRUCache } from 'lru-cache';
import { cacheConfig } from '../config/index.js';

export interface CacheOptions {
  maxSize?: number;
  ttl?: number;
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
}

// Cinemeta cache (long TTL since this data rarely changes)
export const cinemetaCache = createCache<CinemetaFilmData>({
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

// ── Cache stats export ───────────────────────────────────────────────────────

export interface CacheStats {
  [key: string]: { size: number; max: number };
}

export function getCacheStats(): CacheStats {
  return {
    film: { size: filmCache.size, max: filmCache.max },
    userRating: { size: userRatingCache.size, max: userRatingCache.max },
    imdbToLetterboxd: { size: imdbToLetterboxdCache.size, max: imdbToLetterboxdCache.max },
    userLists: { size: userListsCache.size, max: userListsCache.max },
    cinemeta: { size: cinemetaCache.size, max: cinemetaCache.max },
    popularCatalog: { size: popularCatalogCache.size, max: popularCatalogCache.max },
    top250Catalog: { size: top250CatalogCache.size, max: top250CatalogCache.max },
    memberId: { size: memberIdCache.size, max: memberIdCache.max },
    publicWatchlist: { size: publicWatchlistCache.size, max: publicWatchlistCache.max },
    listName: { size: listNameCache.size, max: listNameCache.max },
    likedFilms: { size: likedFilmsCache.size, max: likedFilmsCache.max },
    poster: { size: posterCache.size, max: posterCache.max },
  };
}
