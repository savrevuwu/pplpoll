import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { registerHealth } from './routes/health.js';

export interface ServerDeps {
  db: Kysely<unknown>;
  logger: FastifyBaseLogger;
}

export function buildServer({ db, logger }: ServerDeps): FastifyInstance {
  const app = Fastify({
    // Fastify's default request logs carry method, url, status and timing only — never bodies.
    loggerInstance: logger,
  }) as unknown as FastifyInstance;

  app.setErrorHandler((err: FastifyError, req, reply) => {
    req.log.error({ err }, 'unhandled error');
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    // Never echo internal details to clients (spec §18).
    void reply.code(status).send({
      error: { code: status === 500 ? 'INTERNAL' : 'BAD_REQUEST', message: 'Request failed' },
    });
  });

  registerHealth(app, db);
  return app;
}
