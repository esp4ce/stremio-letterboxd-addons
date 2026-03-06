import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';

export async function setupRateLimit(app: FastifyInstance) {
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
errorResponseBuilder: () => ({
      error: 'Too many requests',
      code: 'RATE_LIMIT_EXCEEDED',
    }),
  });
}

export const loginRateLimit = {
  max: 3,
  timeWindow: '1 minute',
};
