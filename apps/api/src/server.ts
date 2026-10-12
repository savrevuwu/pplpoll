import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { resolveSession, SESSION_COOKIE } from './auth/sessions.js';
import type { AppDeps } from './core/deps.js';
import { AppError } from './core/errors.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerGameRoutes } from './routes/games.js';
import { registerHealth } from './routes/health.js';
import { registerMatchRoutes } from './routes/matches.js';
import { registerPollRoutes } from './routes/polls.js';
import { registerStaffRoutes } from './routes/staff.js';
import { registerSurveyRoutes } from './routes/surveys.js';

export async function buildServer(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    // Fastify's default request logs carry method, url, status and timing only — never bodies.
    loggerInstance: deps.logger,
    trustProxy: true,
  }) as unknown as FastifyInstance;

  await app.register(cookie);
  await app.register(websocket);
  // Limits run after the session is resolved so per-person keys are available.
  await app.register(rateLimit, { global: false, hook: 'preHandler' });

  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    req.auth = token ? await resolveSession(deps.db, token, deps.clock()) : null;
  });

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      return reply
        .code(err.status)
        .send({ error: { code: err.code, message: err.message, ...err.extra } });
    }
    if (err.statusCode === 429) {
      return reply
        .code(429)
        .send({ error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later' } });
    }
    req.log.error({ err }, 'unhandled error');
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    // Never echo internal details to clients (spec §18).
    return reply.code(status).send({
      error: { code: status === 500 ? 'INTERNAL' : 'BAD_REQUEST', message: 'Request failed' },
    });
  });

  registerHealth(app, deps.db as unknown as Kysely<unknown>);
  registerAuthRoutes(app, deps);
  registerAccountRoutes(app, deps);
  registerStaffRoutes(app, deps);
  registerPollRoutes(app, deps);
  registerSurveyRoutes(app, deps);
  registerGameRoutes(app, deps);
  registerMatchRoutes(app, deps);
  return app;
}
