import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, requireRole, requireUser } from '../auth/guards.js';
import type { AppDeps } from '../core/deps.js';
import { parse } from '../core/validate.js';
import * as solo from '../modules/games/solo.js';
import { answerKeysForStaff, mergeAnswerKeys } from '../modules/results/snapshots.js';
import { playerStats, rarestRecord } from '../modules/stats/service.js';

const IdParam = z.strictObject({ id: z.uuid() });

export function registerGameRoutes(app: FastifyInstance, deps: AppDeps): void {
  const user = { preHandler: requireUser };
  const guessing = {
    preHandler: requireUser,
    config: {
      rateLimit: {
        max: deps.answerRateLimit.max,
        timeWindow: deps.answerRateLimit.timeWindowMs,
        keyGenerator: (req: { auth: { userId: string } | null; ip: string }) =>
          req.auth?.userId ?? req.ip,
      },
    },
  };

  app.get('/games/status', user, async (req) => solo.guessingStatus(deps, currentUser(req).userId));

  app.post('/games/mystery', user, async (req, reply) =>
    reply.code(201).send(await solo.startMystery(deps, currentUser(req).userId)),
  );

  app.post('/games/solo', user, async (req, reply) =>
    reply.code(201).send(await solo.startSolo(deps, currentUser(req).userId)),
  );

  app.get('/games/:id', user, async (req) => {
    const { id } = parse(IdParam, req.params);
    return solo.getGame(deps, currentUser(req).userId, id);
  });

  app.post('/games/:id/guesses', guessing, async (req) => {
    const { id } = parse(IdParam, req.params);
    const body = parse(
      z.strictObject({ text: z.string().max(200), clientRequestId: z.string().min(8).max(100) }),
      req.body,
    );
    return solo.submitGuess(deps, currentUser(req).userId, id, body.text, body.clientRequestId);
  });

  app.get('/me/stats', user, async (req) => playerStats(deps.db, currentUser(req).userId));

  app.get('/records/rarest-guess', user, async () => {
    const r = await rarestRecord(deps.db);
    return r ? { percent: r.percent, holders: r.holders } : { percent: null, holders: [] };
  });

  // Staff answer grouping (synonyms/spellings), applied at the next daily snapshot.
  const moderator = { preHandler: requireRole('moderator') };
  app.get('/staff/polls/:id/answer-keys', moderator, async (req) => {
    const { id } = parse(IdParam, req.params);
    return { keys: await answerKeysForStaff(deps, currentUser(req).userId, id) };
  });
  app.post('/staff/polls/:id/answer-groups/merge', moderator, async (req) => {
    const { id } = parse(IdParam, req.params);
    const body = parse(
      z.strictObject({
        keys: z.array(z.string().min(1).max(80)).min(1).max(50),
        into: z.string().min(1).max(80),
      }),
      req.body,
    );
    await mergeAnswerKeys(deps, currentUser(req).userId, id, body.keys, body.into);
    return { ok: true };
  });
}
