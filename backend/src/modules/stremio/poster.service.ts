import sharp from 'sharp';
import { posterCache } from '../../lib/cache.js';
import { createChildLogger } from '../../lib/logger.js';

const logger = createChildLogger('poster-service');

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

  logger.debug({ posterUrl, rating }, 'Generating rated poster');

  const response = await fetch(posterUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch poster: ${response.status}`);
  }

  const imageBuffer = Buffer.from(await response.arrayBuffer());
  const image = sharp(imageBuffer);
  const metadata = await image.metadata();

  const width = metadata.width ?? 300;
  const height = metadata.height ?? 450;

  // Badge dimensions scaled to image size (increased)
  const badgeW = Math.round(width * 0.28);
  const badgeH = Math.round(badgeW * 0.55);
  const margin = Math.round(width * 0.03);
  const fontSize = Math.round(badgeH * 0.58);
  const rx = Math.round(badgeH * 0.15);
  const badgeX = width - badgeW - margin;
  const badgeY = height - badgeH - margin;

  const ratingText = rating.toFixed(1);

  const svgOverlay = `
    <svg width="${width}" height="${height}">
      <rect x="${badgeX}" y="${badgeY}" width="${badgeW}" height="${badgeH}"
            rx="${rx}" ry="${rx}" fill="#111" fill-opacity="0.9"/>
      <text x="${badgeX + badgeW / 2}" y="${badgeY + badgeH / 2 + fontSize * 0.35}"
            font-family="DejaVu Sans, Inter, Arial, Helvetica, sans-serif" font-size="${fontSize}"
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
