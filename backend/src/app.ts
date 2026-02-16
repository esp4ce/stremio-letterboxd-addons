import Fastify from 'fastify';
import type { ServerOptions } from 'node:https';
import cors from '@fastify/cors';
import { config } from './config/index.js';
import { logger } from './lib/logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { setupRateLimit } from './middleware/rate-limit.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { letterboxdRoutes } from './modules/letterboxd/letterboxd.routes.js';
import { stremioRoutes } from './modules/stremio/stremio.routes.js';
import { metricsRoutes } from './modules/metrics/metrics.routes.js';
import { dashboardRoutes } from './modules/dashboard/dashboard.routes.js';
import { generateBaseManifest } from './modules/stremio/stremio.service.js';

export async function buildApp(httpsOptions?: ServerOptions) {
  const app = Fastify({
    logger: false,
    maxParamLength: 10000,
    ...(httpsOptions && { https: httpsOptions }),
  });

  await app.register(cors, {
    origin: config.CORS_ORIGIN.split(',').map((o) => o.trim()),
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await setupRateLimit(app as any);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.setErrorHandler(errorHandler as any);

  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  app.get('/logo.svg', async (_request, reply) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="8" fill="#0a0a0a"/>
  <circle cx="8" cy="16" r="3" fill="#ffffff"/>
  <circle cx="16" cy="16" r="3" fill="#e4e4e7"/>
  <circle cx="24" cy="16" r="3" fill="#a1a1aa"/>
</svg>`;
    return reply
      .header('Content-Type', 'image/svg+xml')
      .header('Cache-Control', 'public, max-age=86400')
      .send(svg);
  });

  app.get('/manifest.json', async (_request, reply) => {
    const manifest = generateBaseManifest();
    return reply
      .header('Content-Type', 'application/json')
      .header('Access-Control-Allow-Origin', '*')
      .header('Cache-Control', 'public, max-age=3600')
      .send(manifest);
  });

  // Stremio opens /configure when configurable: true in manifest
  // Redirect to the frontend configuration page
  app.get('/configure', async (_request, reply) => {
    return reply.redirect('https://stremboxd.com/configure');
  });

  await app.register(authRoutes);
  await app.register(letterboxdRoutes);
  await app.register(stremioRoutes);
  await app.register(metricsRoutes);
  await app.register(dashboardRoutes);

  app.addHook('onRequest', async (request) => {
    logger.debug(
      {
        method: request.method,
        url: request.url,
      },
      'Incoming request'
    );

    // Memory usage warning (Railway Hobby limit: 512MB)
    const memUsage = process.memoryUsage().heapUsed / 1024 / 1024;
    if (memUsage > 400) {
      logger.warn({ memoryMB: memUsage.toFixed(2) }, 'High memory usage detected');
    }
  });

  app.addHook('onResponse', async (request, reply) => {
    logger.info(
      {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
      },
      'Request completed'
    );
  });

  return app;
}
