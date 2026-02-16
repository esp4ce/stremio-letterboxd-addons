import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyJwtToken } from '../../lib/jwt.js';

export async function verifyDashboardAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Unauthorized: Missing or invalid authorization header' });
  }

  const token = authHeader.slice(7); // Remove "Bearer "

  try {
    const payload = await verifyJwtToken(token);

    if (!payload || payload['role'] !== 'admin') {
      return reply.status(401).send({ error: 'Unauthorized: Invalid token or insufficient permissions' });
    }

    // Token is valid, continue to route handler
  } catch (error) {
    return reply.status(401).send({
      error: 'Unauthorized: Token verification failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
