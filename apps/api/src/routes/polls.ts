import { NON_REFUNDABLE_REASONS, REFUNDABLE_REASONS, type RejectionReason } from '@pplpoll/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, requireRole, requireUser } from '../auth/guards.js';
import type { AppDeps } from '../core/deps.js';
import { AppError, errors } from '../core/errors.js';
import { parse } from '../core/validate.js';
import * as daily from '../modules/daily/service.js';
import { listNotifications, markRead } from '../modules/notifications/service.js';
import * as proposals from '../modules/polls/proposals.js';
import { ppSummary } from '../modules/pp/ledger.js';

const visibility = z.enum(['public', 'anonymous']);
const questionText = z.string().max(500);
const IdParam = z.strictObject({ id: z.uuid() });
const DateParam = z.strictObject({ date: z.iso.date() });
const route = z.enum(['normal', 'sensitive', 'similarity']);
const rejectReason = z.enum([...REFUNDABLE_REASONS, ...NON_REFUNDABLE_REASONS] as unknown as [
  RejectionReason,
  ...RejectionReason[],
]);
const note = z.string().trim().min(1).max(500);

const Decision = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('approve'), text: questionText.optional() }),
  z.strictObject({ action: z.literal('reject'), reason: rejectReason, note: note.optional() }),
]);

export function registerPollRoutes(app: FastifyInstance, deps: AppDeps): void {
  // ---- Members ----
  app.post('/proposals', { preHandler: requireUser }, async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 100) {
      throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
    }
    const body = parse(z.strictObject({ text: questionText, visibility }), req.body);
    const result = await proposals.submitProposal(deps, currentUser(req).userId, {
      ...body,
      idempotencyKey: key,
    });
    return reply.code(result.status === 'pending' ? 201 : 200).send(result);
  });

  app.get('/me/polls', { preHandler: requireUser }, async (req) => ({
    polls: await proposals.myPolls(deps, currentUser(req).userId),
  }));

  app.get('/me/pp', { preHandler: requireUser }, async (req) =>
    ppSummary(deps.db, currentUser(req).userId),
  );

  app.put('/me/settings/poll-attribution', { preHandler: requireUser }, async (req) => {
    const { hideNameOnAllPolls } = parse(
      z.strictObject({ hideNameOnAllPolls: z.boolean() }),
      req.body,
    );
    await proposals.setHideNameOnPolls(deps, currentUser(req).userId, hideNameOnAllPolls);
    return { hideNameOnAllPolls };
  });

  app.get('/me/notifications', { preHandler: requireUser }, async (req) => ({
    notifications: await listNotifications(deps.db, currentUser(req).userId),
  }));

  app.post('/me/notifications/:id/read', { preHandler: requireUser }, async (req) => {
    const { id } = parse(IdParam, req.params);
    return { updated: await markRead(deps.db, currentUser(req).userId, id, deps.clock()) };
  });

  app.get('/daily/poll', { preHandler: requireUser }, async () =>
    daily.todaysDailyPoll(deps.db, deps.clock()),
  );

  // ---- Staff: proposal review (Moderator and above) ----
  const moderator = { preHandler: requireRole('moderator') };
  const superMod = { preHandler: requireRole('super_moderator') };
  const admin = { preHandler: requireRole('admin') };

  app.get('/staff/proposals', moderator, async (req) => {
    const q = parse(z.strictObject({ route }), req.query);
    return { proposals: await proposals.listQueue(deps, q.route) };
  });

  app.post('/staff/proposals/:id/decision', moderator, async (req) => {
    const { id } = parse(IdParam, req.params);
    const d = parse(Decision, req.body);
    return proposals.decideProposal(deps, currentUser(req).userId, id, d as proposals.Decision);
  });

  app.post('/staff/proposals/:id/route', moderator, async (req) => {
    const { id } = parse(IdParam, req.params);
    const body = parse(z.strictObject({ route }), req.body);
    await proposals.moveProposal(deps, currentUser(req).userId, id, body.route);
    return { route: body.route };
  });

  app.post('/staff/proposals/:id/refund-correction', superMod, async (req) => {
    const { id } = parse(IdParam, req.params);
    const body = parse(z.strictObject({ action: z.enum(['grant', 'reverse']), note }), req.body);
    await proposals.correctRefund(deps, currentUser(req).userId, id, body.action, body.note);
    return { ok: true };
  });

  app.patch('/staff/polls/:id', moderator, async (req) => {
    const { id } = parse(IdParam, req.params);
    const body = parse(z.strictObject({ text: questionText }), req.body);
    await proposals.editQueuedPoll(deps, currentUser(req).userId, id, body.text);
    return { ok: true };
  });

  // ---- Staff: seeding and the Daily Poll calendar (Admin/Owner) ----
  app.post('/staff/polls', admin, async (req, reply) => {
    const body = parse(
      z.strictObject({ text: questionText, visibility: visibility.default('anonymous') }),
      req.body,
    );
    return reply
      .code(201)
      .send(await proposals.createStaffPoll(deps, currentUser(req).userId, body));
  });

  app.get('/staff/daily', admin, async () => daily.calendarOverview(deps));

  app.put('/staff/daily/calendar/:date', admin, async (req) => {
    const { date } = parse(DateParam, req.params);
    const { pollId } = parse(z.strictObject({ pollId: z.uuid() }), req.body);
    await daily.schedulePoll(deps, currentUser(req).userId, date, pollId);
    return { date, pollId };
  });

  app.delete('/staff/daily/calendar/:date', admin, async (req) => {
    const { date } = parse(DateParam, req.params);
    await daily.unschedule(deps, currentUser(req).userId, date);
    return { date, pollId: null };
  });

  app.post('/staff/daily/emergency-replace', admin, async (req) => {
    const body = parse(
      z.strictObject({ reason: note, replacementPollId: z.uuid().optional() }),
      req.body,
    );
    const r = await daily.emergencyReplace(deps, currentUser(req).userId, {
      reason: body.reason,
      ...(body.replacementPollId ? { replacementPollId: body.replacementPollId } : {}),
    });
    if (r.status === 'already_published') throw errors.notFound();
    return r;
  });
}
