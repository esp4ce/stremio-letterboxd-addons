import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/** Stable ID for a known Tier 1 username — same user across days/devices/IPs */
export function usernameToAnonId(username: string): string {
  return 'u:' + createHash('sha256').update(username.toLowerCase()).digest('hex').slice(0, 14);
}

/** Fallback for truly anonymous requests (no username in config) */
export function generateAnonId(request: FastifyRequest): string {
  const today = new Date().toISOString().slice(0, 10);
  return createHash('sha256')
    .update(`${request.ip}${request.headers['user-agent'] ?? ''}${today}`)
    .digest('hex')
    .slice(0, 16);
}
