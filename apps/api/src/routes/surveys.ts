import { etDate } from '@pplpoll/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requireUser } from '../auth/guards.js';
import type { AppDeps } from '../core/deps.js';
import { parse } from '../core/validate.js';
import { readStreaks } from '../modules/streaks/service.js';
import * as surveys from '../modules/surveys/service.js';

const AnswerBody = z.strictObject({ pollId: z.uuid(), text: z.string().max(500) });
const SlotParam = z.strictObject({ slot: z.coerce.number().int().min(1).max(10) });

export function registerSurveyRoutes(app: FastifyInstance, deps: AppDeps): void {
  // Per-person limit on answer submissions, to slow down scripted answering (spec §4).
  const answering = {
    preHandler: requireUser,
    config: {
      rateLimit: {
        max: deps.answerRateLimit.max,
        timeWindow: deps.answerRateLimit.timeWindowMs,
        keyGenerator: (req: FastifyRequest) => req.auth?.userId ?? req.ip,
      },
    },
  };

  app.get('/daily', { preHandler: requireUser }, async (req) =>
    surveys.getDaily(deps, currentUser(req).userId),
  );

  app.post('/daily/poll/response', answering, async (req) => {
    const body = parse(AnswerBody, req.body);
    return surveys.answerDailyPoll(deps, currentUser(req).userId, body.pollId, body.text);
  });

  app.post('/daily/assignments/:slot/response', answering, async (req) => {
    const { slot } = parse(SlotParam, req.params);
    const body = parse(AnswerBody, req.body);
    return surveys.answerAssignment(deps, currentUser(req).userId, slot, body.pollId, body.text);
  });

  app.post('/daily/announcement/seen', { preHandler: requireUser }, async (req) => {
    await surveys.markAnnouncementSeen(deps, currentUser(req).userId);
    return { ok: true };
  });

  app.get('/me/streaks', { preHandler: requireUser }, async (req) =>
    readStreaks(deps.db, currentUser(req).userId, etDate(deps.clock())),
  );

  app.get('/me/settings/notifications', { preHandler: requireUser }, async (req) =>
    surveys.getNotificationSettings(deps, currentUser(req).userId),
  );

  app.put('/me/settings/notifications', { preHandler: requireUser }, async (req) => {
    const body = parse(
      z.strictObject({
        dailyPollAnnouncement: z.boolean().optional(),
        answeringReminder: z.boolean().optional(),
        guessingReminder: z.boolean().optional(),
      }),
      req.body,
    );
    const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    return surveys.setNotificationSettings(deps, currentUser(req).userId, clean);
  });
}
