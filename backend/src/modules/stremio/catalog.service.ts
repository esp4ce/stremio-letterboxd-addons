import { WatchlistFilm, LogEntry, ListEntry, LogEntryFilm, ActivityItem } from '../letterboxd/letterboxd.client.js';
import { createChildLogger } from '../../lib/logger.js';
import { imdbToLetterboxdCache } from '../../lib/cache.js';
import { serverConfig } from '../../config/index.js';

const logger = createChildLogger('catalog-service');

export interface StremioMeta {
  id: string;
  type: 'movie';
  name: string;
  poster?: string;
  year?: number;
  genres?: string[];
  director?: string[];
  runtime?: string;
  description?: string;
}

/**
 * Extract IMDb ID from Letterboxd film links
 */
function getImdbId(film: WatchlistFilm): string | null {
  const imdbLink = film.links?.find((link) => link.type === 'imdb');
  return imdbLink?.id ?? null;
}

/**
 * Get best poster URL (prefer 300x450 size)
 */
function getPosterUrl(film: WatchlistFilm): string | undefined {
  if (!film.poster?.sizes?.length) return undefined;

  // Prefer 300x450 or closest to it
  const preferred = film.poster.sizes.find((s) => s.width === 300);
  if (preferred) return preferred.url;

  // Fallback to largest available
  return film.poster.sizes[film.poster.sizes.length - 1]?.url;
}

/**
 * Build poster URL with rating badge overlay via proxy
 */
function buildPosterUrl(originalPoster: string | undefined, rating?: number): string | undefined {
  if (!originalPoster || !rating) return originalPoster;
  return `${serverConfig.publicUrl}/poster?url=${encodeURIComponent(originalPoster)}&rating=${rating.toFixed(1)}`;
}

/**
 * Transform Letterboxd watchlist film to Stremio Meta
 */
export function transformToStremioMeta(film: WatchlistFilm): StremioMeta | null {
  const imdbId = getImdbId(film);

  if (!imdbId) {
    logger.warn({ filmId: film.id, filmName: film.name }, 'Film has no IMDb ID, skipping');
    return null;
  }

  return {
    id: imdbId,
    type: 'movie',
    name: film.name,
    poster: buildPosterUrl(getPosterUrl(film), film.rating),
    year: film.releaseYear,
    genres: film.genres?.map((g) => g.name),
    director: film.directors?.map((d) => d.name),
    runtime: film.runTime ? `${film.runTime} min` : undefined,
  };
}

/**
 * Transform array of Letterboxd films to Stremio metas
 */
export function transformWatchlistToMetas(films: WatchlistFilm[]): StremioMeta[] {
  const metas: StremioMeta[] = [];

  for (const film of films) {
    const meta = transformToStremioMeta(film);
    if (meta) {
      metas.push(meta);
    }
  }

  logger.debug({ count: metas.length, total: films.length }, 'Transformed films to metas');
  return metas;
}

/**
 * Extract IMDb ID from LogEntry film
 */
function getLogEntryImdbId(film: LogEntryFilm): string | null {
  const imdbLink = film.links?.find((link) => link.type === 'imdb');
  return imdbLink?.id ?? null;
}

/**
 * Get poster URL from LogEntry film
 */
function getLogEntryPosterUrl(film: LogEntryFilm): string | undefined {
  if (!film.poster?.sizes?.length) return undefined;

  const preferred = film.poster.sizes.find((s) => s.width === 300);
  if (preferred) return preferred.url;

  return film.poster.sizes[film.poster.sizes.length - 1]?.url;
}

/**
 * Transform LogEntry to Stremio Meta
 */
export function transformLogEntryToMeta(entry: LogEntry): StremioMeta | null {
  const imdbId = getLogEntryImdbId(entry.film);

  if (!imdbId) {
    logger.warn({ filmId: entry.film.id, filmName: entry.film.name }, 'LogEntry film has no IMDb ID, skipping');
    return null;
  }

  // Cache IMDb → Letterboxd mapping
  imdbToLetterboxdCache.set(imdbId, entry.film.id);

  // Build description with rating info if available
  let description: string | undefined;
  if (entry.rating) {
    const stars = '★'.repeat(Math.floor(entry.rating)) + (entry.rating % 1 >= 0.5 ? '½' : '');
    description = `Rated ${stars}`;
    if (entry.diaryDate) {
      description += ` on ${entry.diaryDate}`;
    }
    if (entry.owner) {
      description += ` by ${entry.owner.displayName || entry.owner.username}`;
    }
  }

  return {
    id: imdbId,
    type: 'movie',
    name: entry.film.name,
    poster: buildPosterUrl(getLogEntryPosterUrl(entry.film), entry.rating),
    year: entry.film.releaseYear,
    genres: entry.film.genres?.map((g) => g.name),
    director: entry.film.directors?.map((d) => d.name),
    description,
  };
}

/**
 * Transform array of LogEntries to Stremio metas
 * Deduplicates by IMDb ID (keeps first occurrence)
 */
export function transformLogEntriesToMetas(entries: LogEntry[]): StremioMeta[] {
  const metas: StremioMeta[] = [];
  const seenIds = new Set<string>();

  for (const entry of entries) {
    const meta = transformLogEntryToMeta(entry);
    if (meta && !seenIds.has(meta.id)) {
      metas.push(meta);
      seenIds.add(meta.id);
    }
  }

  logger.debug({ count: metas.length, total: entries.length }, 'Transformed log entries to metas');
  return metas;
}

/**
 * Transform ListEntry to Stremio Meta
 */
export function transformListEntryToMeta(entry: ListEntry): StremioMeta | null {
  const film = entry.film;
  const imdbId = getImdbId(film);

  if (!imdbId) {
    logger.warn({ filmId: film.id, filmName: film.name }, 'List entry film has no IMDb ID, skipping');
    return null;
  }

  // Cache IMDb → Letterboxd mapping
  imdbToLetterboxdCache.set(imdbId, film.id);

  return {
    id: imdbId,
    type: 'movie',
    name: film.name,
    poster: buildPosterUrl(getPosterUrl(film), film.rating),
    year: film.releaseYear,
    genres: film.genres?.map((g) => g.name),
    director: film.directors?.map((d) => d.name),
    runtime: film.runTime ? `${film.runTime} min` : undefined,
  };
}

/**
 * Transform array of ListEntries to Stremio metas
 */
export function transformListEntriesToMetas(entries: ListEntry[]): StremioMeta[] {
  const metas: StremioMeta[] = [];

  for (const entry of entries) {
    const meta = transformListEntryToMeta(entry);
    if (meta) {
      metas.push(meta);
    }
  }

  logger.debug({ count: metas.length, total: entries.length }, 'Transformed list entries to metas');
  return metas;
}

/**
 * Extract the film from an ActivityItem (different location depending on type)
 */
function getActivityFilm(item: ActivityItem): WatchlistFilm | undefined {
  if (item.film) return item.film;
  if (item.diaryEntry?.film) return item.diaryEntry.film;
  return undefined;
}

/**
 * Transform ActivityItem to Stremio Meta
 */
function transformActivityItemToMeta(item: ActivityItem): StremioMeta | null {
  const film = getActivityFilm(item);
  if (!film) return null;

  const imdbId = getImdbId(film);
  if (!imdbId) {
    logger.warn({ filmId: film.id, filmName: film.name, activityType: item.type }, 'Activity film has no IMDb ID, skipping');
    return null;
  }

  // Cache IMDb → Letterboxd mapping
  imdbToLetterboxdCache.set(imdbId, film.id);

  // Build description based on activity type
  const memberName = item.member.displayName || item.member.username;
  let description: string | undefined;

  if (item.type === 'FilmRatingActivity' && item.rating) {
    const stars = '★'.repeat(Math.floor(item.rating)) + (item.rating % 1 >= 0.5 ? '½' : '');
    description = `Rated ${stars} by ${memberName}`;
  } else if (item.type === 'WatchlistActivity') {
    description = `Added to watchlist by ${memberName}`;
  } else if (item.type === 'DiaryEntryActivity') {
    const diary = item.diaryEntry;
    const parts: string[] = [];
    if (diary?.like) parts.push('Liked');
    if (diary?.rating) {
      const stars = '★'.repeat(Math.floor(diary.rating)) + (diary.rating % 1 >= 0.5 ? '½' : '');
      parts.push(`Rated ${stars}`);
    }
    parts.push(`by ${memberName}`);
    if (diary?.diaryDetails?.diaryDate) parts.push(`on ${diary.diaryDetails.diaryDate}`);
    description = parts.join(' ');
    // Append review text if available (skip spoilers)
    if (diary?.review?.lbml && !diary.review.containsSpoilers) {
      description += `\n"${diary.review.lbml}"`;
    }
  } else {
    description = `Activity by ${memberName}`;
  }

  const activityRating = item.rating ?? item.diaryEntry?.rating;

  return {
    id: imdbId,
    type: 'movie',
    name: film.name,
    poster: buildPosterUrl(getPosterUrl(film), activityRating),
    year: film.releaseYear,
    genres: film.genres?.map((g) => g.name),
    director: film.directors?.map((d) => d.name),
    description,
  };
}

/**
 * Transform array of ActivityItems to Stremio metas
 * Filters to friends only (excludes own activity) and deduplicates by IMDb ID
 */
export function transformActivityToMetas(items: ActivityItem[], excludeMemberId: string): StremioMeta[] {
  const metas: StremioMeta[] = [];
  const seenIds = new Set<string>();

  for (const item of items) {
    // Skip own activity
    if (item.member.id === excludeMemberId) continue;

    const meta = transformActivityItemToMeta(item);
    if (meta && !seenIds.has(meta.id)) {
      metas.push(meta);
      seenIds.add(meta.id);
    }
  }

  logger.debug({ count: metas.length, total: items.length }, 'Transformed activity items to metas');
  return metas;
}

/**
 * Cache IMDb → Letterboxd ID mapping from a WatchlistFilm
 */
export function cacheFilmMapping(film: WatchlistFilm): void {
  const imdbId = getImdbId(film);
  if (imdbId) {
    imdbToLetterboxdCache.set(imdbId, film.id);
  }
}
