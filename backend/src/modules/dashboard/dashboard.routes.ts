import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { signJwtToken } from '../../lib/jwt.js';
import { config } from '../../config/index.js';
import { verifyDashboardAuth } from './dashboard.middleware.js';
import { getSystemMetrics, getDatabaseMetrics, generateAlerts } from '../../lib/system-metrics.js';
import {
  getTopUsers, getMetricsSummary, getTotalUniqueUsers, getPeakHours,
  getTopStreamedFilms, getTopAccessedLists, getActionBreakdown, getTopActionedFilms, getCatalogBreakdown,
} from '../../lib/metrics.js';
import { getCacheStats, getCacheMetrics, cinemetaCache, listNameCache } from '../../lib/cache.js';
import { getFullFilmInfoFromCinemeta } from '../stremio/meta.service.js';
import { callWithAppToken } from '../../lib/app-client.js';
import { getList as rawGetList, getFilmByLid as rawGetFilmByLid } from '../letterboxd/letterboxd.client.js';
import { createChildLogger } from '../../lib/logger.js';

const logger = createChildLogger('dashboard');

/** Run async tasks with limited concurrency */
async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    results.push(...await Promise.all(batch.map(fn)));
  }
  return results;
}

const loginSchema = z.object({
  password: z.string(),
});

export async function dashboardRoutes(app: FastifyInstance) {
  // Public auth endpoint
  app.post<{
    Body: z.infer<typeof loginSchema>;
  }>('/api/dashboard/auth', async (request, reply) => {
    const body = loginSchema.safeParse(request.body);

    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid request body' });
    }

    if (body.data.password !== config.DASHBOARD_PASSWORD) {
      return reply.status(401).send({ error: 'Invalid password' });
    }

    // Generate JWT with admin role (7 days expiry)
    const token = await signJwtToken({ sub: 'dashboard', role: 'admin' }, '7d');

    return { token };
  });

  // Protected endpoint: detailed system health
  app.get('/health/detailed', {
    preHandler: verifyDashboardAuth,
    handler: async () => {
      const systemMetrics = await getSystemMetrics();
      const dbMetrics = getDatabaseMetrics();
      const cacheStats = getCacheStats();
      const alerts = generateAlerts(systemMetrics, dbMetrics);

      return {
        system: systemMetrics,
        database: dbMetrics,
        caches: cacheStats,
        cacheHitRates: getCacheMetrics(),
        alerts,
      };
    },
  });

  // Protected endpoint: top users with real usernames
  app.get<{
    Querystring: { days?: string; limit?: string };
  }>(
    '/metrics/users',
    {
      preHandler: verifyDashboardAuth,
    },
    async (request) => {
      const days = request.query.days ? parseInt(request.query.days, 10) : 30;
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : 50;

      const clampedDays = days === 0 ? 0 : Math.min(Math.max(days, 1), 365);
      const clampedLimit = Math.min(Math.max(limit, 1), 100);

      return getTopUsers(clampedDays, clampedLimit);
    }
  );

  // Protected endpoint: enriched metrics summary
  app.get<{
    Querystring: { days?: string };
  }>(
    '/metrics/summary',
    {
      preHandler: verifyDashboardAuth,
    },
    async (request) => {
      const days = request.query.days ? parseInt(request.query.days, 10) : 30;
      const clampedDays = days === 0 ? 0 : Math.min(Math.max(days, 1), 365);

      return getMetricsSummary(clampedDays, true);
    }
  );

  // Protected endpoint: anonymous + audience metrics
  app.get<{
    Querystring: { days?: string };
  }>(
    '/metrics/anonymous',
    {
      preHandler: verifyDashboardAuth,
    },
    async (request) => {
      const days = request.query.days ? parseInt(request.query.days, 10) : 30;
      const clampedDays = days === 0 ? 0 : Math.min(Math.max(days, 1), 365);

      const topFilms = getTopStreamedFilms(clampedDays, 15);
      const topLists = getTopAccessedLists(clampedDays, 15);
      const topActionedFilms = getTopActionedFilms(clampedDays, 15);

      // Resolve film titles: imdbId → Cinemeta, filmId (Letterboxd LID) → Letterboxd API
      const titleMap = new Map<string, string>(); // key = imdbId or filmId

      // 1. Collect all imdbIds
      const imdbIds = new Set<string>();
      for (const f of topFilms) imdbIds.add(f.imdbId);
      for (const f of topActionedFilms) if (f.imdbId) imdbIds.add(f.imdbId);

      // 2. Resolve imdbId → title via Cinemeta (5 concurrent max)
      await mapConcurrent([...imdbIds], 5, async (imdbId) => {
        try {
          const cached = cinemetaCache.get(imdbId);
          if (cached) {
            titleMap.set(imdbId, cached.year ? `${cached.name} (${cached.year})` : cached.name);
            return;
          }
          const data = await getFullFilmInfoFromCinemeta(imdbId);
          if (data) {
            titleMap.set(imdbId, data.year ? `${data.name} (${data.year})` : data.name);
          }
        } catch (err) {
          logger.warn({ err, imdbId }, 'Failed to resolve film title from Cinemeta');
        }
      });

      // 3. Resolve Letterboxd filmId → title for actioned films without imdbId (3 concurrent max)
      const unresolvedLids = topActionedFilms.filter((f) => !f.imdbId || !titleMap.has(f.imdbId));
      const lidSet = [...new Set(unresolvedLids.map((f) => f.filmId))].filter((lid) => !titleMap.has(lid));
      await mapConcurrent(lidSet, 3, async (lid) => {
        try {
          const film = await callWithAppToken((token) => rawGetFilmByLid(token, lid));
          titleMap.set(lid, film.releaseYear ? `${film.name} (${film.releaseYear})` : film.name);
        } catch (err) {
          logger.warn({ err, lid }, 'Failed to resolve film title from Letterboxd');
        }
      });

      // 4. Resolve list names from cache or API (3 concurrent max)
      const unresolvedLists = topLists.filter((l) => !l.listName);
      for (const list of unresolvedLists) {
        const cached = listNameCache.get(list.listId);
        if (cached) { list.listName = cached; }
      }
      await mapConcurrent(unresolvedLists.filter((l) => !l.listName), 3, async (list) => {
        try {
          const listData = await callWithAppToken((token) => rawGetList(token, list.listId));
          list.listName = listData.name;
          listNameCache.set(list.listId, listData.name);
        } catch (err) {
          logger.warn({ err, listId: list.listId }, 'Failed to resolve list name');
        }
      });

      // Enrich films: try imdbId first, then filmId
      const enrichFilm = <T extends { imdbId?: string; filmId?: string }>(f: T) => ({
        ...f,
        title: (f.imdbId && titleMap.get(f.imdbId)) ?? (f.filmId && titleMap.get(f.filmId)),
      });

      return {
        uniqueUsers: getTotalUniqueUsers(clampedDays),
        peakHours: getPeakHours(clampedDays),
        topFilms: topFilms.map(enrichFilm),
        topLists,
        actions: getActionBreakdown(clampedDays),
        topActionedFilms: topActionedFilms.map(enrichFilm),
        catalogBreakdown: getCatalogBreakdown(clampedDays),
      };
    }
  );
}
