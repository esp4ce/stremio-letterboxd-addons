import { createHmac, timingSafeEqual } from 'node:crypto';
import { jwtConfig } from '../config/index.js';

const TOKEN_BYTES = 8; // 16 hex chars

function computeToken(userId: string, filmId: string, action: string): string {
  const message = `action:${userId}:${filmId}:${action}`;
  const hmac = createHmac('sha256', jwtConfig.secret).update(message).digest('hex');
  return hmac.slice(0, TOKEN_BYTES * 2);
}

export function signAction(userId: string, filmId: string, action: string): string {
  return computeToken(userId, filmId, action);
}

export function verifyAction(userId: string, filmId: string, action: string, token: string): boolean {
  if (!token || token.length !== TOKEN_BYTES * 2) return false;
  const expected = computeToken(userId, filmId, action);
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(token, 'hex'));
  } catch {
    return false;
  }
}
