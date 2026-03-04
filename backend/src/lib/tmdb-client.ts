import { createChildLogger } from './logger.js';

const logger = createChildLogger('tmdb-client');

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const MAX_CONCURRENT = 10;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY = 1000;

export interface TmdbRecommendation {
  id: number;
  title: string;
  release_date?: string;
  poster_path?: string | null;
  vote_average?: number;
}

interface TmdbRecommendationsResponse {
  results: TmdbRecommendation[];
}

interface TmdbExternalIds {
  imdb_id?: string | null;
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

// Global semaphore — TMDB rate limits are per API key, not per user
const semaphore = new Semaphore(MAX_CONCURRENT);

async function tmdbFetch<T>(url: string): Promise<T> {
  await semaphore.acquire();
  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(url);

      if (response.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = response.headers.get('retry-after');
        const delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : RETRY_BASE_DELAY * Math.pow(2, attempt);
        logger.warn({ attempt, delay }, 'TMDB rate limited, retrying');
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (!response.ok) {
        throw new Error(`TMDB API error: ${response.status} ${response.statusText}`);
      }

      return (await response.json()) as T;
    }
    throw new Error('TMDB API: max retries exceeded');
  } finally {
    semaphore.release();
  }
}

export async function getTmdbRecommendations(
  tmdbId: number,
  apiKey: string,
): Promise<TmdbRecommendation[]> {
  const url = `${TMDB_BASE_URL}/movie/${tmdbId}/recommendations?api_key=${apiKey}&language=en-US&page=1`;
  const data = await tmdbFetch<TmdbRecommendationsResponse>(url);
  return data.results ?? [];
}

export async function getTmdbExternalIds(
  tmdbId: number,
  apiKey: string,
): Promise<TmdbExternalIds> {
  const url = `${TMDB_BASE_URL}/movie/${tmdbId}/external_ids?api_key=${apiKey}`;
  return tmdbFetch<TmdbExternalIds>(url);
}
