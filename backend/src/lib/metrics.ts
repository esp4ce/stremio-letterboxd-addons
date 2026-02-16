import { getDb } from '../db/index.js';

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
  | 'login';

export function trackEvent(event: EventType, userId?: string, metadata?: Record<string, unknown>): void {
  try {
    const db = getDb();
    db.prepare(
      'INSERT INTO events (event, user_id, metadata) VALUES (?, ?, ?)'
    ).run(event, userId ?? null, metadata ? JSON.stringify(metadata) : null);
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
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const totalEvents = db.prepare(
    'SELECT COUNT(*) as count FROM events WHERE created_at >= ?'
  ).get(since) as { count: number };

  const totalUsers = db.prepare(
    'SELECT COUNT(DISTINCT user_id) as count FROM events WHERE user_id IS NOT NULL AND created_at >= ?'
  ).get(since) as { count: number };

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
    total_events: totalEvents.count,
    total_users: totalUsers.count,
    events_by_type: byTypeMap,
    daily_events: dailyEvents,
    daily_active_users: dailyActiveUsers,
    top_catalogs: topCatalogs,
  };

  if (includeEnriched) {
    // Growth metrics
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const eventsLast7Days = (
      db.prepare('SELECT COUNT(*) as count FROM events WHERE created_at >= ?').get(since7d) as { count: number }
    ).count;

    const newUsersLast7Days = (
      db.prepare('SELECT COUNT(*) as count FROM users WHERE created_at >= ?').get(since7d) as { count: number }
    ).count;

    const avgEventsPerDay = dailyEvents.length > 0
      ? dailyEvents.reduce((sum, d) => sum + d.count, 0) / dailyEvents.length
      : 0;

    // Database stats
    const pageCount = db.pragma('page_count', { simple: true }) as number;
    const pageSize = db.pragma('page_size', { simple: true }) as number;
    const sizeBytes = pageCount * pageSize;
    const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2);

    const projectedGrowthBytes = (avgEventsPerDay * 30 * 500); // ~500 bytes per event
    const projectedSizeMB = ((sizeBytes + projectedGrowthBytes) / 1024 / 1024).toFixed(2);

    const totalEventsAll = (
      db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number }
    ).count;

    const oldestEvent = (
      db.prepare('SELECT created_at FROM events ORDER BY created_at ASC LIMIT 1').get() as { created_at: string } | undefined
    )?.created_at ?? null;

    summary.growth = {
      eventsLast7Days,
      eventsLast30Days: totalEvents.count,
      newUsersLast7Days,
      avgEventsPerDay: parseFloat(avgEventsPerDay.toFixed(2)),
      projectedDbSizeIn30Days: projectedSizeMB,
    };

    summary.database = {
      totalEvents: totalEventsAll,
      oldestEvent,
      sizeBytes,
      sizeMB,
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
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Overview stats
  const totalUsers = (
    db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }
  ).count;

  const activeUsers7d = (
    db.prepare('SELECT COUNT(DISTINCT user_id) as count FROM events WHERE user_id IS NOT NULL AND created_at >= ?')
      .get(since7d) as { count: number }
  ).count;

  const activeUsers30d = (
    db.prepare('SELECT COUNT(DISTINCT user_id) as count FROM events WHERE user_id IS NOT NULL AND created_at >= ?')
      .get(since) as { count: number }
  ).count;

  const totalEvents = (
    db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number }
  ).count;

  const avgEventsPerUser = totalUsers > 0 ? totalEvents / totalUsers : 0;

  const newUsersLast7d = (
    db.prepare('SELECT COUNT(*) as count FROM users WHERE created_at >= ?').get(since7d) as { count: number }
  ).count;

  const newUsersLast30d = (
    db.prepare('SELECT COUNT(*) as count FROM users WHERE created_at >= ?').get(since) as { count: number }
  ).count;

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

export function cleanupOldEvents(daysToKeep: number = 90): number {
  const db = getDb();
  const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();

  const result = db.prepare('DELETE FROM events WHERE created_at < ?').run(cutoffDate);

  return result.changes;
}
