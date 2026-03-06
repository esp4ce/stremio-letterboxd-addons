import sharp from 'sharp';
import { posterCache } from '../../lib/cache.js';
import { createChildLogger } from '../../lib/logger.js';

const logger = createChildLogger('poster-service');

// Semaphore to limit concurrent poster image fetches (CDN rate-limiting protection)
const MAX_CONCURRENT_FETCHES = 8;
let activeFetches = 0;
const fetchQueue: Array<() => void> = [];

function acquireFetchSlot(): Promise<void> {
  if (activeFetches < MAX_CONCURRENT_FETCHES) {
    activeFetches++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    fetchQueue.push(() => { activeFetches++; resolve(); });
  });
}

function releaseFetchSlot(): void {
  activeFetches--;
  const next = fetchQueue.shift();
  if (next) next();
}

/**
 * Generate a poster image with a rating badge overlay
 * Minimal cinema aesthetic: white badge, black text
 */
export async function generateRatedPoster(
  posterUrl: string,
  rating: number
): Promise<Buffer> {
  const cacheKey = `${posterUrl}:${rating}`;
  const cached = posterCache.get(cacheKey);
  if (cached) return cached;

  logger.debug({ posterUrl, rating, queueSize: fetchQueue.length }, 'Generating rated poster');

  let response!: Response;
  await acquireFetchSlot();
  try {
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      response = await fetch(posterUrl);
      if (response.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = response.headers.get('retry-after');
        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000 * Math.pow(2, attempt);
        logger.warn({ attempt, delay, posterUrl }, 'CDN rate-limited (429), retrying');
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      break;
    }
  } finally {
    releaseFetchSlot();
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch poster: ${response.status}`);
  }

  const imageBuffer = Buffer.from(await response.arrayBuffer());
  const image = sharp(imageBuffer);
  const metadata = await image.metadata();

  const width = metadata.width ?? 300;
  const height = metadata.height ?? 450;

  // Pill badge: dark background, Letterboxd 3-dot logo left, rating right
  const badgeH = Math.round(width * 0.13);
  const margin = Math.round(width * 0.04);
  const rx = Math.round(badgeH * 0.5);
  const r = Math.round(badgeH * 0.27);        // circle radius
  const gap = Math.round(r * 1.55);            // center-to-center (slight overlap)
  const hPad = Math.round(badgeH * 0.3);
  const fontSize = Math.round(badgeH * 0.50);
  const ratingText = rating.toFixed(1);
  const logoSectionW = hPad + r + gap * 2 + r + hPad;
  const ratingW = Math.round(fontSize * ratingText.length * 0.65);
  const badgeW = logoSectionW + ratingW + hPad;
  const badgeX = width - badgeW - margin;
  const badgeY = height - badgeH - margin;
  const cy = Math.round(badgeY + badgeH / 2);
  const cx1 = badgeX + hPad + r;
  const cx2 = cx1 + gap;
  const cx3 = cx2 + gap;
  const textX = badgeX + logoSectionW + ratingW / 2;
  const textY = cy + Math.round(fontSize * 0.36);

  const svgOverlay = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <!-- Dark pill background -->
      <rect x="${badgeX}" y="${badgeY}" width="${badgeW}" height="${badgeH}"
            rx="${rx}" ry="${rx}" fill="#1a1a1a" fill-opacity="0.92"/>
      <!-- Letterboxd 3-dot logo: green, orange, blue -->
      <circle cx="${cx1}" cy="${cy}" r="${r}" fill="#00C030"/>
      <circle cx="${cx2}" cy="${cy}" r="${r}" fill="#FF8000"/>
      <circle cx="${cx3}" cy="${cy}" r="${r}" fill="#40BCF4"/>
      <!-- Subtle divider -->
      <line x1="${badgeX + logoSectionW}" y1="${badgeY + badgeH * 0.2}"
            x2="${badgeX + logoSectionW}" y2="${badgeY + badgeH * 0.8}"
            stroke="white" stroke-opacity="0.2" stroke-width="1"/>
      <!-- Rating -->
      <text x="${textX}" y="${textY}"
            font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="${fontSize}"
            font-weight="bold" fill="white" text-anchor="middle">${ratingText}</text>
    </svg>`;

  const result = await image
    .composite([{ input: Buffer.from(svgOverlay), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();

  posterCache.set(cacheKey, result);
  logger.debug({ posterUrl, rating, size: result.length }, 'Rated poster generated');

  return result;
}
