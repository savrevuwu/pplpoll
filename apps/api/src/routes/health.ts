import { sql, type Kysely } from 'kysely';
import type { FastifyInstance } from 'fastify';

export function registerHealth(app: FastifyInstance, db: Kysely<unknown>): void {
  app.get('/health', async (_req, reply) => {
    try {
      await sql`SELECT 1`.execute(db);
      return { status: 'ok', db: 'ok' };
    } catch (err) {
      app.log.error({ err }, 'health check: database unavailable');
      return reply.code(503).send({ status: 'degraded', db: 'unavailable' });
    }
  });
}
