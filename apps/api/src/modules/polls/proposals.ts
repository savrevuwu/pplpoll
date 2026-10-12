import type { Database, ProposalRoute, Visibility } from '@pplpoll/db';
import {
  cleanQuestionText,
  isRefundable,
  isValidQuestionText,
  mentionsSensitiveTerm,
  questionExactKey,
  SIMILARITY_THRESHOLD,
  type RejectionReason,
} from '@pplpoll/domain';
import { sql, type Transaction } from 'kysely';
import { audit } from '../../core/audit.js';
import type { AppDeps } from '../../core/deps.js';
import { AppError, errors, isUniqueViolation } from '../../core/errors.js';
import { notify } from '../notifications/service.js';
import { creditPp, debitPp } from '../pp/ledger.js';

const MAX_SUBMISSIONS_PER_HOUR = 10;

const invalidText = () =>
  new AppError(400, 'VALIDATION_FAILED', 'Some fields are invalid', { fields: ['text'] });
export const duplicatePoll = () =>
  new AppError(409, 'DUPLICATE_POLL', 'An identical question already exists');

export interface SubmitResult {
  proposalId: string;
  status: 'pending' | 'rejected';
  reason?: 'duplicate_exact';
  refunded: boolean;
}

function prepareText(input: string): { text: string; key: string } {
  const text = cleanQuestionText(input);
  if (!isValidQuestionText(text)) throw invalidText();
  return { text, key: questionExactKey(text) };
}

async function findSimilar(trx: Transaction<Database>, key: string) {
  const polls = await trx
    .selectFrom('polls')
    .select(['id', 'text', sql<number>`similarity(exact_key, ${key})`.as('score')])
    .where(sql<boolean>`similarity(exact_key, ${key}) >= ${SIMILARITY_THRESHOLD}`)
    .orderBy('score', 'desc')
    .limit(5)
    .execute();
  const proposals = await trx
    .selectFrom('poll_proposals')
    .select(['id', 'text', sql<number>`similarity(exact_key, ${key})`.as('score')])
    .where('status', '=', 'pending')
    .where(sql<boolean>`similarity(exact_key, ${key}) >= ${SIMILARITY_THRESHOLD}`)
    .orderBy('score', 'desc')
    .limit(5)
    .execute();
  return [
    ...polls.map((p) => ({ type: 'poll', id: p.id, text: p.text, score: Number(p.score) })),
    ...proposals.map((p) => ({ type: 'proposal', id: p.id, text: p.text, score: Number(p.score) })),
  ];
}

/**
 * Submits a proposal for 1 PP (spec §9). Retrying with the same idempotency key never charges twice.
 * Exact duplicates (after trivial normalization) are rejected automatically and refunded.
 */
export async function submitProposal(
  deps: AppDeps,
  userId: string,
  input: { text: string; visibility: Visibility; idempotencyKey: string },
): Promise<SubmitResult> {
  const { text, key } = prepareText(input.text);
  const now = deps.clock();

  const existing = async () => {
    const p = await deps.db
      .selectFrom('poll_proposals')
      .select(['id', 'status', 'decision_reason', 'refunded'])
      .where('creator_user_id', '=', userId)
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirst();
    return p
      ? ({
          proposalId: p.id,
          status: p.status === 'pending' ? 'pending' : 'rejected',
          ...(p.decision_reason === 'duplicate_exact'
            ? { reason: 'duplicate_exact' as const }
            : {}),
          refunded: p.refunded,
        } satisfies SubmitResult)
      : null;
  };
  const prior = await existing();
  if (prior) return prior;

  const recent = await deps.db
    .selectFrom('poll_proposals')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('creator_user_id', '=', userId)
    .where('created_at', '>', new Date(now.getTime() - 3600_000))
    .executeTakeFirstOrThrow();
  if (Number(recent.n) >= MAX_SUBMISSIONS_PER_HOUR) {
    throw new AppError(429, 'RATE_LIMITED', 'Too many submissions. Try again later');
  }

  try {
    return await deps.db.transaction().execute(async (trx) => {
      const exact =
        (await trx
          .selectFrom('polls')
          .select('id')
          .where('exact_key', '=', key)
          .executeTakeFirst()) ??
        (await trx
          .selectFrom('poll_proposals')
          .select('id')
          .where('exact_key', '=', key)
          .where('status', '=', 'pending')
          .executeTakeFirst());
      const similar = exact ? [] : await findSimilar(trx, key);
      const route: ProposalRoute =
        similar.length > 0 ? 'similarity' : mentionsSensitiveTerm(text) ? 'sensitive' : 'normal';

      const proposal = await trx
        .insertInto('poll_proposals')
        .values({
          creator_user_id: userId,
          text,
          exact_key: key,
          visibility: input.visibility,
          route,
          idempotency_key: input.idempotencyKey,
          similar_to: JSON.stringify(similar),
          created_at: now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await debitPp(trx, { userId, kind: 'proposal_debit', refId: proposal.id, at: now });
      await audit(trx, {
        actor: userId,
        action: 'proposal.submit',
        targetType: 'proposal',
        targetId: proposal.id,
        detail: { route },
      });

      if (exact) {
        await closeProposal(trx, {
          proposalId: proposal.id,
          creatorId: userId,
          status: 'rejected',
          reason: 'duplicate_exact',
          actor: null,
          at: now,
        });
        return {
          proposalId: proposal.id,
          status: 'rejected',
          reason: 'duplicate_exact',
          refunded: true,
        };
      }
      return { proposalId: proposal.id, status: 'pending', refunded: false };
    });
  } catch (err) {
    // A concurrent retry with the same idempotency key won the race: return its result.
    if (isUniqueViolation(err)) {
      const raced = await existing();
      if (raced) return raced;
    }
    throw err;
  }
}

async function closeProposal(
  trx: Transaction<Database>,
  c: {
    proposalId: string;
    creatorId: string;
    status: 'rejected' | 'revision_requested';
    reason: RejectionReason;
    note?: string;
    actor: string | null;
    at: Date;
  },
): Promise<boolean> {
  const refund = isRefundable(c.reason);
  await trx
    .updateTable('poll_proposals')
    .set({
      status: c.status,
      decision_reason: c.reason,
      refunded: refund,
      decided_by: c.actor,
      decided_at: c.at,
    })
    .where('id', '=', c.proposalId)
    .execute();
  if (refund)
    await creditPp(trx, {
      userId: c.creatorId,
      kind: 'proposal_refund',
      refId: c.proposalId,
      actor: c.actor ?? undefined,
      at: c.at,
    });
  await audit(trx, {
    actor: c.actor,
    action: c.status === 'rejected' ? 'proposal.reject' : 'proposal.request_revision',
    targetType: 'proposal',
    targetId: c.proposalId,
    detail: { reason: c.reason, refunded: refund, note: c.note ?? null },
  });
  await notify(trx, {
    userId: c.creatorId,
    kind: c.status === 'rejected' ? 'proposal_rejected' : 'proposal_revision_requested',
    payload: {
      proposalId: c.proposalId,
      reason: c.reason,
      refunded: refund,
      ...(c.note ? { note: c.note } : {}),
    },
    at: c.at,
  });
  return refund;
}

export type Decision =
  | { action: 'approve'; text?: string }
  | { action: 'reject'; reason: RejectionReason; note?: string }
  | { action: 'request_revision'; note: string };

/** Staff review (spec §9). Wording edits happen only here, before the poll exists. */
export async function decideProposal(
  deps: AppDeps,
  actorId: string,
  proposalId: string,
  decision: Decision,
) {
  const now = deps.clock();
  try {
    return await deps.db.transaction().execute(async (trx) => {
      const p = await trx
        .selectFrom('poll_proposals')
        .selectAll()
        .where('id', '=', proposalId)
        .forUpdate()
        .executeTakeFirst();
      if (!p) throw errors.notFound();
      if (p.status !== 'pending')
        throw new AppError(409, 'ALREADY_DECIDED', 'This proposal was already decided');

      if (decision.action === 'approve') {
        const { text, key } = decision.text
          ? prepareText(decision.text)
          : { text: p.text, key: p.exact_key };
        const poll = await trx
          .insertInto('polls')
          .values({
            proposal_id: p.id,
            text,
            exact_key: key,
            creator_user_id: p.creator_user_id,
            creator_visibility: p.visibility,
            approved_by: actorId,
            approved_at: now,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .updateTable('poll_proposals')
          .set({ status: 'approved', decided_by: actorId, decided_at: now })
          .where('id', '=', p.id)
          .execute();
        await audit(trx, {
          actor: actorId,
          action: 'proposal.approve',
          targetType: 'proposal',
          targetId: p.id,
          detail: { pollId: poll.id, ...(text !== p.text ? { before: p.text, after: text } : {}) },
        });
        await notify(trx, {
          userId: p.creator_user_id,
          kind: 'proposal_approved',
          payload: { proposalId: p.id },
          at: now,
        });
        return { status: 'approved' as const, pollId: poll.id };
      }

      const refunded = await closeProposal(trx, {
        proposalId: p.id,
        creatorId: p.creator_user_id,
        status: decision.action === 'reject' ? 'rejected' : 'revision_requested',
        reason: decision.action === 'reject' ? decision.reason : 'revision_requested',
        ...(decision.note ? { note: decision.note } : {}),
        actor: actorId,
        at: now,
      });
      return {
        status:
          decision.action === 'reject' ? ('rejected' as const) : ('revision_requested' as const),
        refunded,
      };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'polls_exact_key_key')) throw duplicatePoll();
    throw err;
  }
}

export async function moveProposal(
  deps: AppDeps,
  actorId: string,
  proposalId: string,
  route: ProposalRoute,
) {
  await deps.db.transaction().execute(async (trx) => {
    const p = await trx
      .selectFrom('poll_proposals')
      .select(['route', 'status'])
      .where('id', '=', proposalId)
      .forUpdate()
      .executeTakeFirst();
    if (!p) throw errors.notFound();
    if (p.status !== 'pending')
      throw new AppError(409, 'ALREADY_DECIDED', 'This proposal was already decided');
    await trx.updateTable('poll_proposals').set({ route }).where('id', '=', proposalId).execute();
    await audit(trx, {
      actor: actorId,
      action: 'proposal.move',
      targetType: 'proposal',
      targetId: proposalId,
      detail: { before: p.route, after: route },
    });
  });
}

/** Authorized staff can correct a mistaken refund decision (spec §9). */
export async function correctRefund(
  deps: AppDeps,
  actorId: string,
  proposalId: string,
  action: 'grant' | 'reverse',
  note: string,
) {
  const now = deps.clock();
  await deps.db.transaction().execute(async (trx) => {
    const p = await trx
      .selectFrom('poll_proposals')
      .select(['status', 'refunded', 'creator_user_id'])
      .where('id', '=', proposalId)
      .forUpdate()
      .executeTakeFirst();
    if (!p) throw errors.notFound();
    if (p.status === 'pending' || p.status === 'approved') {
      throw new AppError(
        409,
        'NOT_REFUNDABLE_STATE',
        'Only rejected proposals can have refunds corrected',
      );
    }
    if (action === 'grant') {
      if (p.refunded) throw new AppError(409, 'ALREADY_REFUNDED', 'Already refunded');
      await creditPp(trx, {
        userId: p.creator_user_id,
        kind: 'proposal_refund',
        refId: proposalId,
        actor: actorId,
        at: now,
      });
    } else {
      if (!p.refunded) throw new AppError(409, 'NOT_REFUNDED', 'No refund to reverse');
      await debitPp(trx, {
        userId: p.creator_user_id,
        kind: 'refund_reversal',
        refId: proposalId,
        actor: actorId,
        at: now,
      });
    }
    await trx
      .updateTable('poll_proposals')
      .set({ refunded: action === 'grant' })
      .where('id', '=', proposalId)
      .execute();
    await audit(trx, {
      actor: actorId,
      action: `proposal.refund_${action}`,
      targetType: 'proposal',
      targetId: proposalId,
      detail: { note },
    });
  });
}

/** Staff queue view. Staff can always see who created a proposal (spec §9). */
export async function listQueue(deps: AppDeps, route: ProposalRoute) {
  return deps.db
    .selectFrom('poll_proposals as p')
    .innerJoin('profiles as pr', 'pr.user_id', 'p.creator_user_id')
    .select([
      'p.id',
      'p.text',
      'p.visibility',
      'p.route',
      'p.similar_to as similarTo',
      'p.created_at as createdAt',
      'pr.username as creator',
    ])
    .where('p.status', '=', 'pending')
    .where('p.route', '=', route)
    .orderBy('p.created_at')
    .execute();
}

/** Owner/Admin seed polls with no PP cost; they enter the same zero-response queue (decision Q2). */
export async function createStaffPoll(
  deps: AppDeps,
  actorId: string,
  input: { text: string; visibility: Visibility },
) {
  const { text, key } = prepareText(input.text);
  const now = deps.clock();
  try {
    return await deps.db.transaction().execute(async (trx) => {
      const poll = await trx
        .insertInto('polls')
        .values({
          text,
          exact_key: key,
          creator_user_id: actorId,
          creator_visibility: input.visibility,
          approved_by: actorId,
          approved_at: now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await audit(trx, {
        actor: actorId,
        action: 'poll.staff_create',
        targetType: 'poll',
        targetId: poll.id,
      });
      return { pollId: poll.id };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'polls_exact_key_key')) throw duplicatePoll();
    throw err;
  }
}

/** Staff may correct wording only while a poll is still queued with zero responses (spec §9). */
export async function editQueuedPoll(
  deps: AppDeps,
  actorId: string,
  pollId: string,
  input: string,
) {
  const { text, key } = prepareText(input);
  try {
    await deps.db.transaction().execute(async (trx) => {
      const poll = await trx
        .selectFrom('polls')
        .select(['status', 'text'])
        .where('id', '=', pollId)
        .forUpdate()
        .executeTakeFirst();
      if (!poll) throw errors.notFound();
      if (poll.status !== 'queued') {
        throw new AppError(
          409,
          'POLL_NOT_EDITABLE',
          'Only polls that have not debuted can be edited; a reworded live poll must be a new poll',
        );
      }
      await trx
        .updateTable('polls')
        .set({ text, exact_key: key })
        .where('id', '=', pollId)
        .execute();
      await audit(trx, {
        actor: actorId,
        action: 'poll.edit_wording',
        targetType: 'poll',
        targetId: pollId,
        detail: { before: poll.text, after: text },
      });
    });
  } catch (err) {
    if (isUniqueViolation(err, 'polls_exact_key_key')) throw duplicatePoll();
    throw err;
  }
}

/** My Polls: approved questions only, with respondent counts (spec §9). */
export async function myPolls(deps: AppDeps, userId: string) {
  const rows = await deps.db
    .selectFrom('polls')
    .select([
      'id',
      'text',
      'creator_visibility as visibility',
      'status',
      'response_count as respondents',
    ])
    .where('creator_user_id', '=', userId)
    .where('status', '!=', 'removed')
    .orderBy('approved_at', 'desc')
    .execute();
  return rows.map((r) => ({ ...r, status: r.status === 'queued' ? 'waiting_for_debut' : 'live' }));
}

export async function setHideNameOnPolls(deps: AppDeps, userId: string, hide: boolean) {
  await deps.db.transaction().execute(async (trx) => {
    await trx
      .updateTable('users')
      .set({ hide_name_on_polls: hide })
      .where('id', '=', userId)
      .execute();
    await audit(trx, {
      actor: userId,
      action: 'settings.hide_name_on_polls',
      targetType: 'user',
      targetId: userId,
      detail: { hide },
    });
  });
}
