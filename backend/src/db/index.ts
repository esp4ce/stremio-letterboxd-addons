import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';
import { createChildLogger } from '../lib/logger.js';

const logger = createChildLogger('database');

const __dirname = dirname(fileURLToPath(import.meta.url));

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function initDb(): Database.Database {
  if (db) {
    return db;
  }

  const dbPath = config.DATABASE_PATH;
  const dbDir = dirname(dbPath);

  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
    logger.info({ path: dbDir }, 'Created database directory');
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  logger.info({ path: dbPath }, 'Database connected');

  runMigrations(db);

  return db;
}

function runMigrations(database: Database.Database): void {
  const migrationsDir = join(__dirname, 'migrations');

  database.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const appliedMigrations = database
    .prepare('SELECT name FROM migrations')
    .all() as Array<{ name: string }>;
  const appliedSet = new Set(appliedMigrations.map((m) => m.name));

  const migrationFiles = ['001_create_users.sql', '002_add_user_preferences.sql', '003_create_events.sql', '004_add_anonymous_tracking.sql', '005_tier1_users.sql'];

  for (const file of migrationFiles) {
    if (appliedSet.has(file)) {
      continue;
    }

    const filePath = join(migrationsDir, file);
    if (!existsSync(filePath)) {
      logger.warn({ file }, 'Migration file not found');
      continue;
    }

    const sql = readFileSync(filePath, 'utf-8');

    database.transaction(() => {
      database.exec(sql);
      database.prepare('INSERT INTO migrations (name) VALUES (?)').run(file);
    })();

    logger.info({ migration: file }, 'Applied migration');
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database connection closed');
  }
}
