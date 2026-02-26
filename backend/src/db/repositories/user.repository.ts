import { getDb } from '../index.js';
import { encrypt, decrypt } from '../../lib/crypto.js';

export interface UserPreferences {
  catalogs: { watchlist: boolean; diary: boolean; friends: boolean; popular: boolean; top250: boolean; likedFilms: boolean };
  ownLists: string[];
  externalLists: Array<{
    id: string;
    name: string;
    owner: string;
    filmCount: number;
  }>;
  externalWatchlists?: Array<{ username: string; displayName: string }>;
  showActions?: boolean;
  showRatings?: boolean;
  catalogNames?: Record<string, string>;
  catalogOrder?: string[];
}

export interface User {
  id: string;
  letterboxd_id: string;
  letterboxd_username: string;
  letterboxd_display_name: string | null;
  encrypted_refresh_token: string | null;
  tier: number;
  created_at: string;
  updated_at: string;
  last_login_at: string;
  token_expires_at: string | null;
  preferences: string | null;
}

export interface CreateUserInput {
  letterboxdId: string;
  letterboxdUsername: string;
  letterboxdDisplayName?: string;
  refreshToken: string;
  tokenExpiresAt?: Date;
}

export interface UpdateUserInput {
  refreshToken?: string;
  tokenExpiresAt?: Date;
  letterboxdDisplayName?: string;
  preferences?: string;
}

export function findUserById(id: string): User | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
  return (stmt.get(id) as User) ?? null;
}

export function findUserByLetterboxdId(letterboxdId: string): User | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM users WHERE letterboxd_id = ?');
  return (stmt.get(letterboxdId) as User) ?? null;
}

export function findUserByLetterboxdUsername(username: string): User | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM users WHERE letterboxd_username = ?').get(username) as User) ?? null;
}

export function createUser(input: CreateUserInput): User {
  const db = getDb();
  const encryptedToken = encrypt(input.refreshToken);

  const stmt = db.prepare(`
    INSERT INTO users (
      letterboxd_id,
      letterboxd_username,
      letterboxd_display_name,
      encrypted_refresh_token,
      token_expires_at
    ) VALUES (?, ?, ?, ?, ?)
    RETURNING *
  `);

  return stmt.get(
    input.letterboxdId,
    input.letterboxdUsername,
    input.letterboxdDisplayName ?? null,
    encryptedToken,
    input.tokenExpiresAt?.toISOString() ?? null
  ) as User;
}

export function updateUser(id: string, input: UpdateUserInput): User | null {
  const db = getDb();
  const updates: string[] = [];
  const values: unknown[] = [];

  if (input.refreshToken !== undefined) {
    updates.push('encrypted_refresh_token = ?');
    values.push(encrypt(input.refreshToken));
  }

  if (input.tokenExpiresAt !== undefined) {
    updates.push('token_expires_at = ?');
    values.push(input.tokenExpiresAt.toISOString());
  }

  if (input.letterboxdDisplayName !== undefined) {
    updates.push('letterboxd_display_name = ?');
    values.push(input.letterboxdDisplayName);
  }

  if (input.preferences !== undefined) {
    updates.push('preferences = ?');
    values.push(input.preferences);
  }

  if (updates.length === 0) {
    return findUserById(id);
  }

  updates.push("updated_at = datetime('now')");
  values.push(id);

  const stmt = db.prepare(`
    UPDATE users
    SET ${updates.join(', ')}
    WHERE id = ?
    RETURNING *
  `);

  return (stmt.get(...values) as User) ?? null;
}

export function updateLastLogin(id: string): void {
  const db = getDb();
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(
    id
  );
}

export function getDecryptedRefreshToken(user: User): string {
  if (!user.encrypted_refresh_token) {
    throw new Error('User has no refresh token (Tier 1 user)');
  }
  return decrypt(user.encrypted_refresh_token);
}

export function upsertTier1User(letterboxdId: string, username: string, displayName?: string): User {
  const db = getDb();
  const existing = findUserByLetterboxdId(letterboxdId);
  if (existing) {
    // Upgrade to Tier 2 if they already have a refresh token; otherwise just update display name
    if (existing.tier === 1) {
      db.prepare("UPDATE users SET letterboxd_display_name = ?, updated_at = datetime('now') WHERE id = ?")
        .run(displayName ?? null, existing.id);
    }
    return findUserById(existing.id) ?? existing;
  }
  return db.prepare(`
    INSERT INTO users (letterboxd_id, letterboxd_username, letterboxd_display_name, encrypted_refresh_token, tier)
    VALUES (?, ?, ?, NULL, 1)
    RETURNING *
  `).get(letterboxdId, username, displayName ?? null) as User;
}

export function upsertUser(input: CreateUserInput): User {
  const db = getDb();
  const existing = findUserByLetterboxdId(input.letterboxdId);

  if (existing) {
    updateLastLogin(existing.id);
    // Upgrade Tier 1 → Tier 2 when user authenticates with password
    if (existing.tier === 1) {
      db.prepare('UPDATE users SET tier = 2 WHERE id = ?').run(existing.id);
    }
    const updated = updateUser(existing.id, {
      refreshToken: input.refreshToken,
      tokenExpiresAt: input.tokenExpiresAt,
      letterboxdDisplayName: input.letterboxdDisplayName,
    });
    return updated ?? existing;
  }

  return createUser(input);
}

export function getUserPreferences(user: User): UserPreferences | null {
  if (!user.preferences) return null;
  try {
    return JSON.parse(user.preferences) as UserPreferences;
  } catch {
    return null;
  }
}

export function updateUserPreferences(
  id: string,
  prefs: UserPreferences
): User | null {
  return updateUser(id, { preferences: JSON.stringify(prefs) });
}
