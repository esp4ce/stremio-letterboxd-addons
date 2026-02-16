import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { jwtConfig } from '../config/index.js';

export interface UserTokenPayload extends JWTPayload {
  sub: string; // user.id
  letterboxdId: string;
  username: string;
}

function getSecret(): Uint8Array {
  return new TextEncoder().encode(jwtConfig.secret);
}

function parseTtl(ttl: string): number {
  const match = ttl.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Invalid TTL format: ${ttl}`);
  }

  const value = parseInt(match[1]!, 10);
  const unit = match[2];

  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
  };

  return value * (multipliers[unit!] ?? 1);
}

export async function signUserToken(payload: {
  userId: string;
  letterboxdId: string;
  username: string;
}): Promise<string> {
  const ttlSeconds = parseTtl(jwtConfig.ttl);

  return new SignJWT({
    letterboxdId: payload.letterboxdId,
    username: payload.username,
  } satisfies Partial<UserTokenPayload>)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(getSecret());
}

export async function verifyUserToken(
  token: string
): Promise<UserTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return payload as UserTokenPayload;
  } catch {
    return null;
  }
}

// Generic JWT functions for dashboard and other non-user-specific uses
export async function signJwtToken(payload: Record<string, unknown>, ttl?: string): Promise<string> {
  const ttlSeconds = parseTtl(ttl ?? jwtConfig.ttl);

  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds);

  if (payload['sub'] && typeof payload['sub'] === 'string') {
    jwt.setSubject(payload['sub']);
  }

  return jwt.sign(getSecret());
}

export async function verifyJwtToken(token: string): Promise<JWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return payload;
  } catch {
    return null;
  }
}
