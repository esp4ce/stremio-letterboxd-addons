import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/** Ephemeral ID for requests without a known username (rotates daily) */
export function generateAnonId(request: FastifyRequest): string {
  const today = new Date().toISOString().slice(0, 10);
  return createHash('sha256')
    .update(`${request.ip}${request.headers['user-agent'] ?? ''}${today}`)
    .digest('hex')
    .slice(0, 16);
}
