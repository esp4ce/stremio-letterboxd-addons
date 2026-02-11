import { AuthenticatedClient, LetterboxdFilm } from '../letterboxd/letterboxd.client.js';
import { createChildLogger } from '../../lib/logger.js';
import { imdbToLetterboxdCache, cinemetaCache } from '../../lib/cache.js';
import type { CachedRating, CinemetaFilmData } from '../../lib/cache.js';
import { serverConfig } from '../../config/index.js';

const logger = createChildLogger('meta-service');

// ============================================================================
// Interfaces
// ============================================================================

interface FilmLookupResult {
  letterboxdFilmId: string;
  film: LetterboxdFilm;
  cinemetaData?: CinemetaFilmData;
}

// ============================================================================
// Cinemeta Integration
// ============================================================================

/**
 * Fetch full film info from Cinemeta (public API)
 * Returns: name, year, poster, background, genres, director, cast, writer, runtime, description, trailers
 */
async function getFullFilmInfoFromCinemeta(imdbId: string): Promise<CinemetaFilmData | null> {
  // Check cache first
  const cached = cinemetaCache.get(imdbId);
  if (cached) {
    logger.debug({ imdbId }, 'Cinemeta cache hit');
    return cached;
  }

  try {
    const response = await fetch(`https://v3-cinemeta.strem.io/meta/movie/${imdbId}.json`);
    if (!response.ok) {
      logger.debug({ imdbId, status: response.status }, 'Cinemeta lookup failed');
      return null;
    }

    const data = await response.json() as {
      meta?: {
        name?: string;
        year?: string;
        releaseInfo?: string;
        poster?: string;
        background?: string;
        genres?: string[];
        director?: string[];
        cast?: string[];
        writer?: string[];
        runtime?: string;
        description?: string;
        trailers?: Array<{ source: string; type: string }>;
      };
    };

    if (!data.meta?.name) {
      return null;
    }

    const meta = data.meta;
    const year = meta.year ? parseInt(meta.year, 10) :
                 meta.releaseInfo ? parseInt(meta.releaseInfo, 10) : undefined;

    const cinemetaData: CinemetaFilmData = {
      name: meta.name!,
      year,
      poster: meta.poster,
      background: meta.background,
      genres: meta.genres,
      director: meta.director,
      cast: meta.cast,
      writer: meta.writer,
      runtime: meta.runtime,
      description: meta.description,
      trailers: meta.trailers,
    };

    logger.info({ imdbId, name: meta.name, year, hasTrailers: !!meta.trailers?.length }, 'Got film info from Cinemeta');

    // Cache the result
    cinemetaCache.set(imdbId, cinemetaData);

    return cinemetaData;
  } catch (error) {
    logger.error({ error, imdbId }, 'Error fetching from Cinemeta');
    return null;
  }
}

// ============================================================================
// Letterboxd Film Lookup (with Search Fallback)
// ============================================================================

/**
 * Try to find Letterboxd film by searching with name + year
 */
async function findFilmBySearch(
  client: AuthenticatedClient,
  name: string,
  year?: number
): Promise<LetterboxdFilm | null> {
  try {
    logger.info({ name, year }, 'Searching Letterboxd for film');

    const results = await client.searchFilms(name, { year, perPage: 10 });

    if (!results.items.length) {
      logger.debug({ name, year }, 'No search results found');
      return null;
    }

    // Try to find exact match first
    const exactMatch = results.items.find(film => {
      const nameMatch = film.name.toLowerCase() === name.toLowerCase();
      const yearMatch = !year || film.releaseYear === year;
      return nameMatch && yearMatch;
    });

    if (exactMatch) {
      logger.info({ filmId: exactMatch.id, filmName: exactMatch.name }, 'Found exact match via search');
      return exactMatch;
    }

    // Try partial match with same year
    if (year) {
      const yearMatch = results.items.find(film => film.releaseYear === year);
      if (yearMatch) {
        logger.info({ filmId: yearMatch.id, filmName: yearMatch.name }, 'Found year match via search');
        return yearMatch;
      }
    }

    // Fall back to first result (already checked that items.length > 0)
    const firstResult = results.items[0]!;
    logger.info({ filmId: firstResult.id, filmName: firstResult.name }, 'Using first search result');
    return firstResult;
  } catch (error) {
    logger.error({ error, name, year }, 'Error searching for film');
    return null;
  }
}

/**
 * Try to find Letterboxd film by IMDb ID using cache, external ID lookup, or search fallback
 */
export async function findFilmByImdb(
  client: AuthenticatedClient,
  imdbId: string
): Promise<FilmLookupResult | null> {
  // Check cache first
  const cached = imdbToLetterboxdCache.get(imdbId);
  if (cached) {
    logger.debug({ imdbId, letterboxdFilmId: cached }, 'IMDb→Letterboxd cache hit');
    try {
      const film = await client.getFilmByLid(cached);
      return { letterboxdFilmId: cached, film };
    } catch (error) {
      logger.warn({ error, imdbId, letterboxdFilmId: cached }, 'Cached Letterboxd ID invalid, trying external lookup');
    }
  }

  // Try the external ID endpoint first (most reliable)
  try {
    logger.info({ imdbId }, 'Calling getFilmByExternalId...');
    const film = await client.getFilmByExternalId(imdbId, 'imdb');

    if (film) {
      // Cache the mapping
      imdbToLetterboxdCache.set(imdbId, film.id);
      logger.info({ imdbId, letterboxdFilmId: film.id, filmName: film.name }, 'Found Letterboxd film via external ID');
      return { letterboxdFilmId: film.id, film };
    }
  } catch (error) {
    logger.debug({ error, imdbId }, 'External ID lookup failed');
  }

  // Fallback: Get info from Cinemeta and search Letterboxd
  logger.info({ imdbId }, 'External ID returned 404, trying Cinemeta + search fallback');

  const cinemetaData = await getFullFilmInfoFromCinemeta(imdbId);
  if (!cinemetaData) {
    logger.debug({ imdbId }, 'Cannot find film: Cinemeta lookup failed');
    return null;
  }

  // Search Letterboxd with the name and year from Cinemeta
  const film = await findFilmBySearch(client, cinemetaData.name, cinemetaData.year);
  if (!film) {
    logger.debug({ imdbId, name: cinemetaData.name }, 'Cannot find film: Letterboxd search returned no results');
    return null;
  }

  // Cache the mapping for future lookups
  imdbToLetterboxdCache.set(imdbId, film.id);
  logger.info({ imdbId, letterboxdFilmId: film.id, filmName: film.name }, 'Found Letterboxd film via search fallback');

  return { letterboxdFilmId: film.id, film, cinemetaData };
}

// ============================================================================
// Rating Data
// ============================================================================

/**
 * Get film rating data with caching
 */
export async function getFilmRatingData(
  client: AuthenticatedClient,
  letterboxdFilmId: string,
  userId: string
): Promise<CachedRating> {
  // Always fetch fresh user relationship data so meta page reflects current state
  // (watched/liked/watchlist/rating must be up-to-date when user opens a film)
  logger.info({ letterboxdFilmId }, 'Fetching film relationship and statistics...');

  const [relationship, statistics] = await Promise.all([
    client.getFilmRelationship(letterboxdFilmId),
    client.getFilmStatistics(letterboxdFilmId),
  ]);

  const rating: CachedRating = {
    filmId: letterboxdFilmId,
    userRating: relationship.rating ?? null,
    watched: relationship.watched,
    liked: relationship.liked,
    inWatchlist: relationship.inWatchlist,
    communityRating: statistics.rating ?? null,
    communityRatings: statistics.counts.ratings,
  };

  return rating;
}

// ============================================================================
// Formatting Helpers
// ============================================================================

/**
 * Format a numeric rating as stars (e.g., 3.5 -> "★★★⯪☆", 4 -> "★★★★☆")
 * Uses: ★ (full), ⯪ (half), ☆ (empty)
 */
function formatStars(rating: number, showEmpty: boolean = true): string {
  const fullStars = Math.floor(rating);
  const hasHalf = rating % 1 >= 0.25 && rating % 1 < 0.75;
  const roundUp = rating % 1 >= 0.75;

  const actualFull = roundUp ? fullStars + 1 : fullStars;
  const emptyStars = showEmpty ? 5 - actualFull - (hasHalf && !roundUp ? 1 : 0) : 0;

  let stars = '★'.repeat(actualFull);
  if (hasHalf && !roundUp) {
    stars += '⯪';
  }
  if (showEmpty) {
    stars += '☆'.repeat(emptyStars);
  }

  return stars;
}

/**
 * Format a number with thousands separator (e.g., 45230 -> "45.2K")
 */
function formatNumber(num: number): string {
  if (num >= 1000000) {
    return `${(num / 1000000).toFixed(1)}M`;
  }
  if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}K`;
  }
  return num.toString();
}

// ============================================================================
// Stream Builder: Cross-platform Letterboxd info as stream objects
// ============================================================================

export interface LetterboxdStream {
  name: string;
  description: string;
  externalUrl: string;
  behaviorHints: {
    notWebReady: true;
    bingeGroup: string;
  };
}

/**
 * Build Letterboxd info streams for cross-platform display.
 * Streams support \n in descriptions (white-space: pre) and work on all platforms.
 */
export async function buildLetterboxdStreams(
  client: AuthenticatedClient,
  imdbId: string,
  userId: string
): Promise<LetterboxdStream[]> {
  logger.info({ imdbId, userId }, 'Building Letterboxd streams...');

  const result = await findFilmByImdb(client, imdbId);
  if (!result) {
    return [];
  }

  const { letterboxdFilmId, film } = result;
  const rating = await getFilmRatingData(client, letterboxdFilmId, userId);
  const baseUrl = serverConfig.publicUrl;
  const letterboxdLink = film.links?.find(l => l.type === 'letterboxd');
  const letterboxdUrl = letterboxdLink?.url ?? `https://letterboxd.com/film/${film.id}/`;
  const bingeGroup = `letterboxd-${imdbId}`;

  const streams: LetterboxdStream[] = [];

  // ── Stream 1: Rating & Status Info ──
  const infoLines: string[] = [];

  if (rating.communityRating !== null) {
    const stars = formatStars(rating.communityRating, true);
    const countStr = rating.communityRatings > 0 ? ` (${formatNumber(rating.communityRatings)} ratings)` : '';
    infoLines.push(`${stars}  ${rating.communityRating.toFixed(1)}/5${countStr}`);
  }

  const statuses: string[] = [];
  if (rating.watched) statuses.push('✓ Watched');
  if (rating.liked) statuses.push('♥ Liked');
  if (rating.inWatchlist) statuses.push('In Watchlist');
  if (statuses.length > 0) infoLines.push(statuses.join('  ·  '));

  if (rating.userRating !== null) {
    infoLines.push(`Your rating: ${formatStars(rating.userRating, false)} ${rating.userRating.toFixed(1)}`);
  }

  streams.push({
    name: 'Letterboxd',
    description: infoLines.length > 0 ? infoLines.join('\n') : 'View on Letterboxd',
    externalUrl: letterboxdUrl,
    behaviorHints: { notWebReady: true, bingeGroup },
  });

  // ── Stream 2: Rate action ──
  const encodedFilmName = encodeURIComponent(film.name);
  if (rating.userRating !== null) {
    streams.push({
      name: `★ ${rating.userRating.toFixed(1)}`,
      description: 'Change your Letterboxd rating',
      externalUrl: `${baseUrl}/action/${userId}/rate/${letterboxdFilmId}?imdb=${imdbId}&current=${rating.userRating}&name=${encodedFilmName}`,
      behaviorHints: { notWebReady: true, bingeGroup },
    });
  } else {
    streams.push({
      name: '★ Rate',
      description: 'Rate this film on Letterboxd',
      externalUrl: `${baseUrl}/action/${userId}/rate/${letterboxdFilmId}?imdb=${imdbId}&name=${encodedFilmName}`,
      behaviorHints: { notWebReady: true, bingeGroup },
    });
  }

  // ── Stream 3: Watched toggle ──
  streams.push({
    name: rating.watched ? '✓ Watched' : '○ Watch',
    description: rating.watched ? 'Click to remove from watched' : 'Click to mark as watched',
    externalUrl: `${baseUrl}/action/${userId}/watched/${letterboxdFilmId}?set=${!rating.watched}&imdb=${imdbId}`,
    behaviorHints: { notWebReady: true, bingeGroup },
  });

  // ── Stream 4: Liked toggle ──
  streams.push({
    name: rating.liked ? '♥ Liked' : '♡ Like',
    description: rating.liked ? 'Click to unlike' : 'Click to like on Letterboxd',
    externalUrl: `${baseUrl}/action/${userId}/liked/${letterboxdFilmId}?set=${!rating.liked}&imdb=${imdbId}`,
    behaviorHints: { notWebReady: true, bingeGroup },
  });

  // ── Stream 5: Watchlist toggle ──
  streams.push({
    name: rating.inWatchlist ? 'In Watchlist' : '+ Watchlist',
    description: rating.inWatchlist ? 'Click to remove from watchlist' : 'Click to add to watchlist',
    externalUrl: `${baseUrl}/action/${userId}/watchlist/${letterboxdFilmId}?set=${!rating.inWatchlist}&imdb=${imdbId}`,
    behaviorHints: { notWebReady: true, bingeGroup },
  });

  logger.info({ imdbId, streamCount: streams.length }, 'Built Letterboxd streams');
  return streams;
}
