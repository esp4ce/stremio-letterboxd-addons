import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { signJwtToken } from '../../lib/jwt.js';
import { config } from '../../config/index.js';
import { verifyDashboardAuth } from './dashboard.middleware.js';
import { getSystemMetrics, getDatabaseMetrics, generateAlerts } from '../../lib/system-metrics.js';
import { getTopUsers, getMetricsSummary } from '../../lib/metrics.js';
import { getCacheStats } from '../../lib/cache.js';

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

      const clampedDays = Math.min(Math.max(days, 1), 365);
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
      const clampedDays = Math.min(Math.max(days, 1), 365);

      return getMetricsSummary(clampedDays, true);
    }
  );
}
