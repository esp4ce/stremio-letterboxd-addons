import type Database from 'better-sqlite3';
import { getDb } from '../db/index.js';

function sinceDate(days: number): string {
  if (days === 0) return '1970-01-01T00:00:00.000Z';
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function countQuery(db: Database.Database, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { count: number }).count;
}

/** Fill missing hours/days with 0 so charts have continuous data */
function fillTimeGaps(
  data: Array<{ date: string; count: number }>,
  sinceISO: string,
  granularity: 'hour' | 'day',
): Array<{ date: string; count: number }> {
  if (data.length === 0) return data;

  const existing = new Map(data.map((d) => [d.date, d.count]));
  const result: Array<{ date: string; count: number }> = [];
  const now = new Date();
  const start = new Date(sinceISO);

  if (granularity === 'hour') {
    // Round start down to the hour
    start.setMinutes(0, 0, 0);
    const cursor = new Date(start);
    while (cursor <= now) {
      const key = cursor.toISOString().slice(0, 13) + ':00'; // YYYY-MM-DDTHH:00
      result.push({ date: key, count: existing.get(key) ?? 0 });
      cursor.setHours(cursor.getHours() + 1);
    }
  } else {
    // Round start to date
    const cursor = new Date(start.toISOString().slice(0, 10));
    const todayStr = now.toISOString().slice(0, 10);
    while (cursor.toISOString().slice(0, 10) <= todayStr) {
      const key = cursor.toISOString().slice(0, 10); // YYYY-MM-DD
      result.push({ date: key, count: existing.get(key) ?? 0 });
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  return result;
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
  time_events: Array<{ date: string; count: number }>;
  granularity: 'hour' | 'day';
  daily_active_users: Array<{ date: string; count: number }>;
  top_catalogs: Array<{ catalog: string; count: number }>;
  growth?: {
    avgEventsPerDay: number;
    newUsersInPeriod: number;
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

  // Hourly granularity for short periods, daily otherwise
  const useHourly = days > 0 && days <= 1;
  const granularity: 'hour' | 'day' = useHourly ? 'hour' : 'day';

  const rawTimeEvents = useHourly
    ? db.prepare(
        `SELECT strftime('%Y-%m-%dT%H:00', created_at) as date, COUNT(*) as count
         FROM events WHERE created_at >= ?
         GROUP BY strftime('%Y-%m-%dT%H:00', created_at) ORDER BY date ASC`
      ).all(since) as Array<{ date: string; count: number }>
    : db.prepare(
        `SELECT date(created_at) as date, COUNT(*) as count
         FROM events WHERE created_at >= ?
         GROUP BY date(created_at) ORDER BY date ASC`
      ).all(since) as Array<{ date: string; count: number }>;

  // Fill gaps so charts show 0 for missing periods
  const timeEvents = fillTimeGaps(rawTimeEvents, since, granularity);

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
    time_events: timeEvents,
    granularity,
    daily_active_users: dailyActiveUsers,
    top_catalogs: topCatalogs,
  };

  if (includeEnriched) {
    const avgEventsPerDay = timeEvents.length > 0
      ? timeEvents.reduce((sum, d) => sum + d.count, 0) / (useHourly ? 1 : timeEvents.length)
      : 0;

    const newUsersInPeriod = countQuery(db, 'SELECT COUNT(*) as count FROM users WHERE created_at >= ?', since);

    const pageCount = db.pragma('page_count', { simple: true }) as number;
    const pageSize = db.pragma('page_size', { simple: true }) as number;
    const sizeBytes = pageCount * pageSize;

    const totalEventsAll = countQuery(db, 'SELECT COUNT(*) as count FROM events');
    const oldestEvent = (
      db.prepare('SELECT created_at FROM events ORDER BY created_at ASC LIMIT 1').get() as { created_at: string } | undefined
    )?.created_at ?? null;

    summary.growth = {
      avgEventsPerDay: parseFloat(avgEventsPerDay.toFixed(2)),
      newUsersInPeriod,
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
  tier: number;
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
    activeUsers: number;
    totalEvents: number;
    avgEventsPerUser: number;
    newUsers: number;
  };
  topUsers: UserMetrics[];
}

export function getTopUsers(days: number = 30, limit: number = 50): TopUsersMetrics {
  const db = getDb();
  const since = sinceDate(days);

  const totalUsers = countQuery(db, 'SELECT COUNT(*) as count FROM users');
  const activeUsers = countQuery(db, 'SELECT COUNT(DISTINCT user_id) as count FROM events WHERE user_id IS NOT NULL AND created_at >= ?', since);
  const totalEvents = countQuery(db, 'SELECT COUNT(*) as count FROM events WHERE created_at >= ?', since);
  const avgEventsPerUser = totalUsers > 0 ? totalEvents / totalUsers : 0;
  const newUsers = countQuery(db, 'SELECT COUNT(*) as count FROM users WHERE created_at >= ?', since);

  // Top users
  const topUsersRaw = db.prepare(`
    SELECT
      e.user_id,
      u.letterboxd_username,
      u.letterboxd_display_name,
      u.tier,
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
    tier: number;
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
      tier: user.tier ?? 1,
      totalEvents: user.total_events,
      lastActivity: user.last_activity,
      firstSeen: user.first_seen,
      breakdown,
    };
  });

  return {
    overview: {
      totalUsers,
      activeUsers,
      totalEvents,
      avgEventsPerUser: parseFloat(avgEventsPerUser.toFixed(2)),
      newUsers,
    },
    topUsers,
  };
}

export interface UniqueUsersCount {
  tier1: number;
  tier2: number;
  total: number;
}

export function getTotalUniqueUsers(days: number = 30): UniqueUsersCount {
  const db = getDb();
  const since = sinceDate(days);

  const tier2 = countQuery(db, `SELECT COUNT(DISTINCT e.user_id) as count FROM events e JOIN users u ON e.user_id = u.id WHERE u.tier = 2 AND e.created_at >= ?`, since);
  const tier1 = countQuery(db, `SELECT COUNT(DISTINCT e.user_id) as count FROM events e JOIN users u ON e.user_id = u.id WHERE u.tier = 1 AND e.created_at >= ?`, since);

  return { tier1, tier2, total: tier1 + tier2 };
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
