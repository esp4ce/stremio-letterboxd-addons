import { LetterboxdApiError } from '../modules/letterboxd/letterboxd.client.js';
import { createChildLogger } from './logger.js';

const logger = createChildLogger('throttle');

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000;
const MAX_CONCURRENT = 6;
const MIN_INTERVAL_MS = 200; // minimum gap between request starts

// ── Semaphore ────────────────────────────────────────────────────────

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

// ── Interval pacer ──────────────────────────────────────────────────

let nextAvailableSlot = 0;

async function paceRequest(): Promise<void> {
  const now = Date.now();
  const wait = nextAvailableSlot - now;
  nextAvailableSlot = Math.max(now, nextAvailableSlot) + MIN_INTERVAL_MS;
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
}

// ── Global instances ────────────────────────────────────────────────

const semaphore = new Semaphore(MAX_CONCURRENT);

// ── Public API ──────────────────────────────────────────────────────

/**
 * Throttle + retry for all Letterboxd API calls.
 * 1. Limits concurrency via semaphore
 * 2. Paces requests with a minimum interval
 * 3. Retries on 429 with exponential backoff (fallback safety net)
 */
export async function throttled<T>(fn: () => Promise<T>): Promise<T> {
  await semaphore.acquire();
  try {
    await paceRequest();
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof LetterboxdApiError && err.status === 429 && attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
          logger.warn({ attempt, delay }, 'Rate limited (429), retrying');
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw new Error('throttled: exhausted retries');
  } finally {
    semaphore.release();
  }
}
