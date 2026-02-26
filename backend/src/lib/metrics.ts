import type Database from 'better-sqlite3';
import { getDb } from '../db/index.js';

function sinceDate(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function countQuery(db: Database.Database, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { count: number }).count;
}

export type EventType =
  | 'install'
  | 'catalog_watchlist'
  | 'catalog_diary'
  | 'catalog_friends'
  | 'catalog_list'
  | 'catalog_liked'
  | 'catalog_popular'
  | 'catalog_top250'
  | 'stream'
  | 'action_watched'
  | 'action_liked'
  | 'action_watchlist'
  | 'action_rate'
  | 'login'
  | 'manifest_view'
  | 'validate_username';

export function trackEvent(event: EventType, userId?: string, metadata?: Record<string, unknown>, anonymousId?: string): void {
  try {
    const db = getDb();
    db.prepare(
      'INSERT INTO events (event, user_id, metadata, anonymous_id) VALUES (?, ?, ?, ?)'
    ).run(event, userId ?? null, metadata ? JSON.stringify(metadata) : null, anonymousId ?? null);
  } catch {
    // Silently fail — metrics should never break the app
  }
}

export interface MetricsSummary {
  total_events: number;
  total_users: number;
  events_by_type: Record<string, number>;
  daily_events: Array<{ date: string; count: number }>;
  daily_active_users: Array<{ date: string; count: number }>;
  top_catalogs: Array<{ catalog: string; count: number }>;
  growth?: {
    eventsLast7Days: number;
    eventsLast30Days: number;
    newUsersLast7Days: number;
    avgEventsPerDay: number;
    projectedDbSizeIn30Days: string;
  };
  database?: {
    totalEvents: number;
    oldestEvent: string | null;
    sizeBytes: number;
    sizeMB: string;
  };
}

export function getMetricsSummary(days: number = 30, includeEnriched: boolean = false): MetricsSummary {
  const db = getDb();
  const since = sinceDate(days);

  const totalEventsCount = countQuery(db, 'SELECT COUNT(*) as count FROM events WHERE created_at >= ?', since);
  const totalUsersCount = countQuery(db, 'SELECT COUNT(DISTINCT user_id) as count FROM events WHERE user_id IS NOT NULL AND created_at >= ?', since);

  const eventsByType = db.prepare(
    'SELECT event, COUNT(*) as count FROM events WHERE created_at >= ? GROUP BY event ORDER BY count DESC'
  ).all(since) as Array<{ event: string; count: number }>;

  const dailyEvents = db.prepare(
    `SELECT date(created_at) as date, COUNT(*) as count
     FROM events WHERE created_at >= ?
     GROUP BY date(created_at) ORDER BY date DESC`
  ).all(since) as Array<{ date: string; count: number }>;

  const dailyActiveUsers = db.prepare(
    `SELECT date(created_at) as date, COUNT(DISTINCT user_id) as count
     FROM events WHERE user_id IS NOT NULL AND created_at >= ?
     GROUP BY date(created_at) ORDER BY date DESC`
  ).all(since) as Array<{ date: string; count: number }>;

  const topCatalogs = db.prepare(
    `SELECT event as catalog, COUNT(*) as count
     FROM events WHERE event LIKE 'catalog_%' AND created_at >= ?
     GROUP BY event ORDER BY count DESC`
  ).all(since) as Array<{ catalog: string; count: number }>;

  const byTypeMap: Record<string, number> = {};
  for (const row of eventsByType) {
    byTypeMap[row.event] = row.count;
  }

  const summary: MetricsSummary = {
    total_events: totalEventsCount,
    total_users: totalUsersCount,
    events_by_type: byTypeMap,
    daily_events: dailyEvents,
    daily_active_users: dailyActiveUsers,
    top_catalogs: topCatalogs,
  };

  if (includeEnriched) {
    const since7d = sinceDate(7);
    const eventsLast7Days = countQuery(db, 'SELECT COUNT(*) as count FROM events WHERE created_at >= ?', since7d);
    const newUsersLast7Days = countQuery(db, 'SELECT COUNT(*) as count FROM users WHERE created_at >= ?', since7d);

    const avgEventsPerDay = dailyEvents.length > 0
      ? dailyEvents.reduce((sum, d) => sum + d.count, 0) / dailyEvents.length
      : 0;

    const pageCount = db.pragma('page_count', { simple: true }) as number;
    const pageSize = db.pragma('page_size', { simple: true }) as number;
    const sizeBytes = pageCount * pageSize;

    const totalEventsAll = countQuery(db, 'SELECT COUNT(*) as count FROM events');
    const oldestEvent = (
      db.prepare('SELECT created_at FROM events ORDER BY created_at ASC LIMIT 1').get() as { created_at: string } | undefined
    )?.created_at ?? null;

    summary.growth = {
      eventsLast7Days,
      eventsLast30Days: totalEventsCount,
      newUsersLast7Days,
      avgEventsPerDay: parseFloat(avgEventsPerDay.toFixed(2)),
      projectedDbSizeIn30Days: ((sizeBytes + avgEventsPerDay * 30 * 500) / 1024 / 1024).toFixed(2),
    };

    summary.database = {
      totalEvents: totalEventsAll,
      oldestEvent,
      sizeBytes,
      sizeMB: (sizeBytes / 1024 / 1024).toFixed(2),
    };
  }

  return summary;
}

export interface UserMetrics {
  userId: string;
  username: string | null;
  displayName: string | null;
  totalEvents: number;
  lastActivity: string;
  firstSeen: string;
  breakdown: {
    catalog_views: number;
    streams: number;
    actions: number;
    logins: number;
  };
}

export interface TopUsersMetrics {
  overview: {
    totalUsers: number;
    activeUsers7d: number;
    activeUsers30d: number;
    totalEvents: number;
    avgEventsPerUser: number;
    newUsersLast7d: number;
    newUsersLast30d: number;
  };
  topUsers: UserMetrics[];
}

export function getTopUsers(days: number = 30, limit: number = 50): TopUsersMetrics {
  const db = getDb();
  const since = sinceDate(days);
  const since7d = sinceDate(7);

  const totalUsers = countQuery(db, 'SELECT COUNT(*) as count FROM users');
  const activeUsers7d = countQuery(db, 'SELECT COUNT(DISTINCT user_id) as count FROM events WHERE user_id IS NOT NULL AND created_at >= ?', since7d);
  const activeUsers30d = countQuery(db, 'SELECT COUNT(DISTINCT user_id) as count FROM events WHERE user_id IS NOT NULL AND created_at >= ?', since);
  const totalEvents = countQuery(db, 'SELECT COUNT(*) as count FROM events');
  const avgEventsPerUser = totalUsers > 0 ? totalEvents / totalUsers : 0;
  const newUsersLast7d = countQuery(db, 'SELECT COUNT(*) as count FROM users WHERE created_at >= ?', since7d);
  const newUsersLast30d = countQuery(db, 'SELECT COUNT(*) as count FROM users WHERE created_at >= ?', since);

  // Top users
  const topUsersRaw = db.prepare(`
    SELECT
      e.user_id,
      u.letterboxd_username,
      u.letterboxd_display_name,
      COUNT(*) as total_events,
      MAX(e.created_at) as last_activity,
      MIN(e.created_at) as first_seen
    FROM events e
    LEFT JOIN users u ON e.user_id = u.id
    WHERE e.created_at >= ? AND e.user_id IS NOT NULL
    GROUP BY e.user_id
    ORDER BY total_events DESC
    LIMIT ?
  `).all(since, limit) as Array<{
    user_id: string;
    letterboxd_username: string | null;
    letterboxd_display_name: string | null;
    total_events: number;
    last_activity: string;
    first_seen: string;
  }>;

  // Get breakdown for each user
  const topUsers: UserMetrics[] = topUsersRaw.map((user) => {
    const events = db.prepare(`
      SELECT event FROM events WHERE user_id = ? AND created_at >= ?
    `).all(user.user_id, since) as Array<{ event: string }>;

    const breakdown = {
      catalog_views: events.filter((e) => e.event.startsWith('catalog_')).length,
      streams: events.filter((e) => e.event === 'stream').length,
      actions: events.filter((e) => e.event.startsWith('action_')).length,
      logins: events.filter((e) => e.event === 'login').length,
    };

    return {
      userId: user.user_id,
      username: user.letterboxd_username,
      displayName: user.letterboxd_display_name,
      totalEvents: user.total_events,
      lastActivity: user.last_activity,
      firstSeen: user.first_seen,
      breakdown,
    };
  });

  return {
    overview: {
      totalUsers,
      activeUsers7d,
      activeUsers30d,
      totalEvents,
      avgEventsPerUser: parseFloat(avgEventsPerUser.toFixed(2)),
      newUsersLast7d,
      newUsersLast30d,
    },
    topUsers,
  };
}

export interface UniqueUsersCount {
  authenticated: number;
  anonymous: number;
  total: number;
}

export function getTotalUniqueUsers(days: number = 30): UniqueUsersCount {
  const db = getDb();
  const since = sinceDate(days);

  const authenticated = countQuery(db, 'SELECT COUNT(DISTINCT user_id) as count FROM events WHERE user_id IS NOT NULL AND created_at >= ?', since);
  const anonymous = countQuery(db, 'SELECT COUNT(DISTINCT anonymous_id) as count FROM events WHERE user_id IS NULL AND anonymous_id IS NOT NULL AND created_at >= ?', since);

  return { authenticated, anonymous, total: authenticated + anonymous };
}

export interface PeakHourEntry {
  hour: number;
  count: number;
}

export function getPeakHours(days: number = 30): PeakHourEntry[] {
  const db = getDb();
  const since = sinceDate(days);

  const rows = db.prepare(
    `SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour, COUNT(*) as count
     FROM events WHERE created_at >= ?
     GROUP BY strftime('%H', created_at)
     ORDER BY hour`
  ).all(since) as PeakHourEntry[];

  // Fill missing hours with 0
  const hourMap = new Map(rows.map((r) => [r.hour, r.count]));
  return Array.from({ length: 24 }, (_, i) => ({ hour: i, count: hourMap.get(i) ?? 0 }));
}

export interface AddonSurvival {
  avgDays: number;
  medianDays: number;
}

export function getAddonSurvival(days: number = 90): AddonSurvival {
  const db = getDb();
  const since = sinceDate(days);

  const rows = db.prepare(
    `SELECT ROUND(julianday(MAX(created_at)) - julianday(MIN(created_at)), 1) as span_days
     FROM events
     WHERE user_id IS NOT NULL AND created_at >= ?
     GROUP BY user_id
     HAVING COUNT(*) >= 2`
  ).all(since) as Array<{ span_days: number }>;

  if (rows.length === 0) return { avgDays: 0, medianDays: 0 };

  const spans = rows.map((r) => r.span_days).sort((a, b) => a - b);
  const avg = spans.reduce((s, v) => s + v, 0) / spans.length;
  const mid = Math.floor(spans.length / 2);
  const median = spans.length % 2 === 0
    ? (spans[mid - 1]! + spans[mid]!) / 2
    : spans[mid]!;

  return { avgDays: parseFloat(avg.toFixed(1)), medianDays: parseFloat(median.toFixed(1)) };
}

export interface InstallFunnel {
  manifestViews: number;
  catalogFetches: number;
  authenticated: number;
}

export function getInstallFunnel(days: number = 30): InstallFunnel {
  const db = getDb();
  const since = sinceDate(days);

  return {
    manifestViews: countQuery(db, "SELECT COUNT(*) as count FROM events WHERE event = 'manifest_view' AND created_at >= ?", since),
    catalogFetches: countQuery(db, "SELECT COUNT(*) as count FROM events WHERE event LIKE 'catalog_%' AND created_at >= ?", since),
    authenticated: countQuery(db, "SELECT COUNT(*) as count FROM events WHERE event = 'login' AND created_at >= ?", since),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Product metrics — real addon usage data
// ═══════════════════════════════════════════════════════════════════════════

export interface TopFilm {
  imdbId: string;
  title?: string;
  count: number;
}

export function getTopStreamedFilms(days: number = 30, limit: number = 20): TopFilm[] {
  const db = getDb();
  const since = sinceDate(days);

  return db.prepare(
    `SELECT json_extract(metadata, '$.imdbId') as imdbId, COUNT(*) as count
     FROM events
     WHERE event = 'stream' AND metadata IS NOT NULL AND created_at >= ?
     GROUP BY json_extract(metadata, '$.imdbId')
     HAVING imdbId IS NOT NULL
     ORDER BY count DESC
     LIMIT ?`
  ).all(since, limit) as TopFilm[];
}

export interface TopList {
  listId: string;
  listName?: string;
  count: number;
}

export function getTopAccessedLists(days: number = 30, limit: number = 20): TopList[] {
  const db = getDb();
  const since = sinceDate(days);

  return db.prepare(
    `SELECT
       json_extract(metadata, '$.listId') as listId,
       (SELECT json_extract(e2.metadata, '$.listName')
        FROM events e2
        WHERE e2.event = 'catalog_list'
          AND json_extract(e2.metadata, '$.listId') = json_extract(e.metadata, '$.listId')
          AND json_extract(e2.metadata, '$.listName') IS NOT NULL
        ORDER BY e2.created_at DESC LIMIT 1) as listName,
       COUNT(*) as count
     FROM events e
     WHERE event = 'catalog_list' AND metadata IS NOT NULL AND created_at >= ?
     GROUP BY json_extract(metadata, '$.listId')
     HAVING listId IS NOT NULL
     ORDER BY count DESC
     LIMIT ?`
  ).all(since, limit) as TopList[];
}

export interface ActionBreakdown {
  action: string;
  count: number;
}

export function getActionBreakdown(days: number = 30): ActionBreakdown[] {
  const db = getDb();
  const since = sinceDate(days);

  return db.prepare(
    `SELECT event as action, COUNT(*) as count
     FROM events
     WHERE event LIKE 'action_%' AND created_at >= ?
     GROUP BY event
     ORDER BY count DESC`
  ).all(since) as ActionBreakdown[];
}

export interface TopActionedFilm {
  filmId: string;
  imdbId?: string;
  title?: string;
  action: string;
  count: number;
}

export function getTopActionedFilms(days: number = 30, limit: number = 20): TopActionedFilm[] {
  const db = getDb();
  const since = sinceDate(days);

  return db.prepare(
    `SELECT
       json_extract(metadata, '$.filmId') as filmId,
       (SELECT json_extract(e2.metadata, '$.imdbId')
        FROM events e2
        WHERE e2.event LIKE 'action_%'
          AND json_extract(e2.metadata, '$.filmId') = json_extract(e.metadata, '$.filmId')
          AND json_extract(e2.metadata, '$.imdbId') IS NOT NULL
        ORDER BY e2.created_at DESC LIMIT 1) as imdbId,
       event as action,
       COUNT(*) as count
     FROM events e
     WHERE event LIKE 'action_%' AND metadata IS NOT NULL AND created_at >= ?
     GROUP BY json_extract(metadata, '$.filmId'), event
     HAVING filmId IS NOT NULL
     ORDER BY count DESC
     LIMIT ?`
  ).all(since, limit) as TopActionedFilm[];
}

export interface CatalogBreakdownEntry {
  catalog: string;
  tier: string;
  count: number;
}

export function getCatalogBreakdown(days: number = 30): CatalogBreakdownEntry[] {
  const db = getDb();
  const since = sinceDate(days);

  return db.prepare(
    `SELECT event as catalog,
            CASE WHEN user_id IS NOT NULL THEN 'auth' ELSE 'public' END as tier,
            COUNT(*) as count
     FROM events
     WHERE event LIKE 'catalog_%' AND created_at >= ?
     GROUP BY event, tier
     ORDER BY count DESC`
  ).all(since) as CatalogBreakdownEntry[];
}

export function cleanupOldEvents(daysToKeep: number = 90): number {
  const db = getDb();
  const cutoffDate = sinceDate(daysToKeep);

  const result = db.prepare('DELETE FROM events WHERE created_at < ?').run(cutoffDate);

  return result.changes;
}
