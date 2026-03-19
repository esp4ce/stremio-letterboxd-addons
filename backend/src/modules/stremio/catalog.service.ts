import { WatchlistFilm, LogEntry, ListEntry, ActivityItem, LetterboxdFilm } from '../letterboxd/letterboxd.client.js';
import { createChildLogger } from '../../lib/logger.js';
import { imdbToLetterboxdCache, cinemetaCache } from '../../lib/cache.js';
import { serverConfig } from '../../config/index.js';
import { getFullFilmInfoFromCinemeta } from './meta.service.js';
import { mapConcurrent } from '../../lib/concurrency.js';

const logger = createChildLogger('catalog-service');

export interface StremioMeta {
  id: string;
  type: 'movie';
  name: string;
  poster?: string;
  year?: number;
  genres?: string[];
  director?: string[];
  cast?: string[];
  writer?: string[];
  runtime?: string;
  description?: string;
  releaseInfo?: string;
  imdbRating?: string;
  background?: string;
  trailers?: Array<{ source: string; type: string }>;
  /** @internal rank suffix to append after cinemeta description (e.g. "#42") */
  _rankSuffix?: string;
}

/** Shape shared by WatchlistFilm and LogEntryFilm */
interface FilmLike {
  poster?: { sizes?: Array<{ width: number; url: string }> };
  links?: Array<{ type: string; id: string }>;
}

/**
 * Extract IMDb ID from Letterboxd film links
 */
export function getImdbId(film: FilmLike): string | null {
  const imdbLink = film.links?.find((link) => link.type === 'imdb');
  return imdbLink?.id ?? null;
}

/**
 * Extract TMDB ID from Letterboxd film links
 */
export function getTmdbId(film: WatchlistFilm): number | null {
  const tmdbLink = film.links?.find((link) => link.type === 'tmdb');
  if (!tmdbLink?.id) return null;
  const parsed = parseInt(tmdbLink.id, 10);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Get best poster URL (prefer 300x450 size)
 */
export function getPosterUrl(film: FilmLike): string | undefined {
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
export function buildPosterUrl(originalPoster: string | undefined, rating?: number): string | undefined {
  if (!originalPoster || !rating) return originalPoster;
  return `${serverConfig.publicUrl}/poster?url=${encodeURIComponent(originalPoster)}&rating=${rating.toFixed(1)}`;
}

/**
 * Format a personal rating as star glyphs only: "★★★★½"
 */
function formatStarsOnly(rating: number): string {
  const full = Math.floor(rating);
  const half = rating % 1 >= 0.5 ? '½' : '';
  return `${'★'.repeat(full)}${half}`;
}

/**
 * Format ISO date string to readable: "2024-01-15" → "15 Jan 2024"
 */
function formatDiaryDate(isoDate: string): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [year, month, day] = isoDate.split('-');
  if (!year || !month || !day) return isoDate;
  const monthName = months[parseInt(month, 10) - 1];
  if (!monthName) return isoDate;
  return `${parseInt(day, 10)} ${monthName} ${year}`;
}

/**
 * Transform Letterboxd watchlist film to Stremio Meta
 */
export function transformToStremioMeta(film: WatchlistFilm, showRatings = true): StremioMeta | null {
  const imdbId = getImdbId(film);

  if (!imdbId) {
    logger.warn({ filmId: film.id, filmName: film.name }, 'Film has no IMDb ID, skipping');
    return null;
  }

  return {
    id: imdbId,
    type: 'movie',
    name: film.name,
    poster: showRatings ? buildPosterUrl(getPosterUrl(film), film.rating) : getPosterUrl(film),
    year: film.releaseYear,
    genres: film.genres?.map((g) => g.name),
    director: film.directors?.map((d) => d.name),
    runtime: film.runTime ? `${film.runTime} min` : undefined,
  };
}

/**
 * Transform array of Letterboxd films to Stremio metas
 */
export function transformWatchlistToMetas(films: WatchlistFilm[], showRatings = true): StremioMeta[] {
  const metas: StremioMeta[] = [];

  for (const film of films) {
    const meta = transformToStremioMeta(film, showRatings);
    if (meta) {
      metas.push(meta);
    }
  }

  logger.debug({ count: metas.length, total: films.length }, 'Transformed films to metas');
  return metas;
}

/**
 * Transform LogEntry to Stremio Meta
 */
export function transformLogEntryToMeta(entry: LogEntry, showRatings = true): StremioMeta | null {
  const imdbId = getImdbId(entry.film);

  if (!imdbId) {
    logger.warn({ filmId: entry.film.id, filmName: entry.film.name }, 'LogEntry film has no IMDb ID, skipping');
    return null;
  }

  // Cache IMDb → Letterboxd mapping
  imdbToLetterboxdCache.set(imdbId, entry.film.id);

  // Build description: "Liked · My rating ★★★★ · 15 Jan 2024"
  const descParts: string[] = [];
  if (entry.like) descParts.push('♥ Liked');
  if (entry.rating) descParts.push(`My rating ${formatStarsOnly(entry.rating)}`);
  if (entry.diaryDate) descParts.push(formatDiaryDate(entry.diaryDate));
  let description = descParts.length > 0 ? descParts.join(' · ') : undefined;

  // Append review excerpt if available
  if (entry.review?.lbml) {
    const excerpt = entry.review.lbml.length > 100 ? entry.review.lbml.slice(0, 100) + '…' : entry.review.lbml;
    description = description ? `${description}\n"${excerpt}"` : `"${excerpt}"`;
  }

  return {
    id: imdbId,
    type: 'movie',
    name: entry.film.name,
    poster: showRatings ? buildPosterUrl(getPosterUrl(entry.film), entry.rating) : getPosterUrl(entry.film),
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
export function transformLogEntriesToMetas(entries: LogEntry[], showRatings = true): StremioMeta[] {
  const metas: StremioMeta[] = [];
  const seenIds = new Set<string>();

  for (const entry of entries) {
    const meta = transformLogEntryToMeta(entry, showRatings);
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
export function transformListEntryToMeta(entry: ListEntry, showRatings = true): StremioMeta | null {
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
    poster: showRatings ? buildPosterUrl(getPosterUrl(film), film.rating) : getPosterUrl(film),
    year: film.releaseYear,
    genres: film.genres?.map((g) => g.name),
    director: film.directors?.map((d) => d.name),
    runtime: film.runTime ? `${film.runTime} min` : undefined,
    _rankSuffix: entry.rank != null ? `#${entry.rank}` : undefined,
  };
}

/**
 * Transform array of ListEntries to Stremio metas
 */
export function transformListEntriesToMetas(entries: ListEntry[], showRatings = true): StremioMeta[] {
  const metas: StremioMeta[] = [];

  for (const entry of entries) {
    const meta = transformListEntryToMeta(entry, showRatings);
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
function transformActivityItemToMeta(item: ActivityItem, showRatings = true): StremioMeta | null {
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
    description = `Rated ${formatStarsOnly(item.rating)} by ${memberName}`;
  } else if (item.type === 'WatchlistActivity') {
    description = `Added to watchlist by ${memberName}`;
  } else if (item.type === 'DiaryEntryActivity') {
    const diary = item.diaryEntry;
    const parts: string[] = [];
    if (diary?.like) parts.push('Liked');
    if (diary?.rating) {
      parts.push(`Rated ${formatStarsOnly(diary.rating)}`);
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

  return {
    id: imdbId,
    type: 'movie',
    name: film.name,
    poster: showRatings ? buildPosterUrl(getPosterUrl(film), film.rating) : getPosterUrl(film),
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
export function transformActivityToMetas(items: ActivityItem[], excludeMemberId: string, showRatings = true): StremioMeta[] {
  const metas: StremioMeta[] = [];
  const seenIds = new Set<string>();

  for (const item of items) {
    // Skip own activity
    if (item.member.id === excludeMemberId) continue;

    const meta = transformActivityItemToMeta(item, showRatings);
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

/**
 * Transform LetterboxdFilm search results to Stremio metas
 */
export function transformSearchResultsToMetas(films: LetterboxdFilm[]): StremioMeta[] {
  const metas: StremioMeta[] = [];

  for (const film of films) {
    const imdbId = getImdbId(film);
    if (!imdbId) continue;

    imdbToLetterboxdCache.set(imdbId, film.id);

    const directors = film.contributions
      ?.find(c => c.type === 'Director')
      ?.contributors.map(d => d.name);

    metas.push({
      id: imdbId,
      type: 'movie',
      name: film.name,
      poster: getPosterUrl(film),
      year: film.releaseYear,
      genres: film.genres?.map(g => g.name),
      director: directors,
      runtime: film.runTime ? `${film.runTime} min` : undefined,
      description: film.description,
    });
  }

  return metas;
}

const ENRICH_CONCURRENCY = 10;

/**
 * Format minutes as "Xh Ymin" (e.g. 148 → "2h 28min")
 */
function formatRuntime(runtime?: string): string | undefined {
  if (!runtime) return undefined;
  const minutes = parseInt(runtime, 10);
  if (isNaN(minutes) || minutes <= 0) return runtime;
  if (minutes < 60) return `${minutes}min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

/**
 * Apply cached Cinemeta data to a meta (synchronous, no network)
 */
function applyCachedCinemeta(meta: StremioMeta): void {
  const cinemeta = cinemetaCache.get(meta.id);
  if (!cinemeta) return;

  // Description: use cinemeta synopsis, append rank suffix if present
  if (!meta.description && cinemeta.description) {
    meta.description = meta._rankSuffix
      ? `${cinemeta.description}\n\n${meta._rankSuffix}`
      : cinemeta.description;
  }

  if (cinemeta.background) meta.background = cinemeta.background;
  if (cinemeta.releaseInfo) meta.releaseInfo = cinemeta.releaseInfo;
  else if (cinemeta.year) meta.releaseInfo = String(cinemeta.year);
  if (cinemeta.imdbRating) meta.imdbRating = cinemeta.imdbRating;
  if (cinemeta.cast?.length) meta.cast = cinemeta.cast;
  if (cinemeta.writer?.length) meta.writer = cinemeta.writer;
  if (cinemeta.trailers?.length) meta.trailers = cinemeta.trailers;

  // Runtime: prefer Cinemeta, format as hours
  meta.runtime = formatRuntime(cinemeta.runtime || meta.runtime);

  // Cleanup internal field before sending to Stremio
  delete meta._rankSuffix;
}

/**
 * Enrich catalog metas with Cinemeta data (description, background, imdbRating, releaseInfo).
 *
 * Two-phase approach for speed:
 * 1. Synchronously apply any cached Cinemeta data (instant)
 * 2. Fetch missing entries from Cinemeta in parallel, then apply
 *
 * Cache misses are fetched concurrently. On subsequent requests,
 * the Cinemeta cache (1h TTL) makes enrichment near-instant.
 */
export async function enrichMetasWithCinemeta(metas: StremioMeta[]): Promise<StremioMeta[]> {
  // Phase 1: apply from cache (instant)
  const uncached: StremioMeta[] = [];
  for (const meta of metas) {
    if (cinemetaCache.get(meta.id)) {
      applyCachedCinemeta(meta);
    } else {
      uncached.push(meta);
    }
  }

  // Phase 2: fetch missing in parallel, then apply
  if (uncached.length > 0) {
    await mapConcurrent(uncached, ENRICH_CONCURRENCY, async (meta) => {
      await getFullFilmInfoFromCinemeta(meta.id); // populates cache
      applyCachedCinemeta(meta);
    });
  }

  return metas;
}
