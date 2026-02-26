-- Migration: 005_tier1_users
-- Allow Tier 1 users (public config, no password) to be stored in users table
-- Makes encrypted_refresh_token nullable and adds tier column (1 = public, 2 = authenticated)

PRAGMA foreign_keys = OFF;

CREATE TABLE users_v2 (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    letterboxd_id TEXT NOT NULL UNIQUE,
    letterboxd_username TEXT NOT NULL,
    letterboxd_display_name TEXT,
    encrypted_refresh_token TEXT,
    tier INTEGER NOT NULL DEFAULT 2,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    last_login_at TEXT DEFAULT (datetime('now')),
    token_expires_at TEXT,
    preferences TEXT
);

INSERT INTO users_v2
    SELECT id, letterboxd_id, letterboxd_username, letterboxd_display_name,
           encrypted_refresh_token, 2, created_at, updated_at, last_login_at,
           token_expires_at, preferences
    FROM users;

DROP TABLE users;
ALTER TABLE users_v2 RENAME TO users;

CREATE INDEX IF NOT EXISTS idx_users_letterboxd_id ON users(letterboxd_id);
CREATE INDEX IF NOT EXISTS idx_users_tier ON users(tier);

PRAGMA foreign_keys = ON;
