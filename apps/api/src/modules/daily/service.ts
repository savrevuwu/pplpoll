import type { Database } from '@pplpoll/db';
import { etDate } from '@pplpoll/domain';
import { sql, type Kysely, type Transaction } from 'kysely';
import { audit } from '../../core/audit.js';
import type { AppDeps } from '../../core/deps.js';
import { AppError, errors } from '../../core/errors.js';
import { alertStaff, notify } from '../notifications/service.js';
import { publicCreator } from '../polls/attribution.js';

type Db = Pick<AppDeps, 'db'>;

async function lockDay(trx: Transaction<Database>, date: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${'daily:' + date}))`.execute(trx);
}

/** Yesterday's (and any older) live Daily Poll becomes an ordinary survey question (spec §2.5). */
async function retireOldDailyPolls(trx: Transaction<Database>, date: string, now: Date) {
  await trx
    .updateTable('polls')
    .set({ status: 'survey' })
    .where('status', '=', 'live_daily')
    .where('debut_et_date', '<', date)
    .execute();
  await trx
    .updateTable('daily_features')
    .set({ ended_at: now })
    .where('et_date', '<', date)
    .where('active', '=', true)
    .where('ended_at', 'is', null)
    .execute();
}

/**
 * Next queued poll: the explicit pick, else the poll scheduled for `date`, else the oldest approved
 * queued poll not reserved for a later date. Only untouched zero-response polls qualify (spec §2, §23.6).
 */
async function pickPoll(
  trx: Transaction<Database>,
  date: string,
  explicitPollId?: string,
): Promise<{ id: string; source: 'scheduled' | 'auto' | 'staff_pick' } | null> {
  if (explicitPollId) {
    const p = await trx
      .selectFrom('polls')
      .select('id')
      .where('id', '=', explicitPollId)
      .where('status', '=', 'queued')
      .where('response_count', '=', 0)
      .forUpdate()
      .executeTakeFirst();
    if (!p)
      throw new AppError(409, 'POLL_NOT_QUEUED', 'Only an untouched queued poll can be featured');
    return { id: p.id, source: 'staff_pick' };
  }
  const scheduled = await trx
    .selectFrom('daily_schedule as s')
    .innerJoin('polls as p', 'p.id', 's.poll_id')
    .select('p.id')
    .where('s.et_date', '=', date)
    .where('p.status', '=', 'queued')
    .where('p.response_count', '=', 0)
    .forUpdate(['p'])
    .executeTakeFirst();
  if (scheduled) return { id: scheduled.id, source: 'scheduled' };
  const auto = await trx
    .selectFrom('polls as p')
    .select('p.id')
    .where('p.status', '=', 'queued')
    .where('p.response_count', '=', 0)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('daily_schedule as s')
            .select('s.poll_id')
            .whereRef('s.poll_id', '=', 'p.id')
            .where('s.et_date', '>', date),
        ),
      ),
    )
    .orderBy('p.approved_at')
    .orderBy('p.id')
    .limit(1)
    .forUpdate(['p'])
    .skipLocked()
    .executeTakeFirst();
  return auto ? { id: auto.id, source: 'auto' } : null;
}

async function feature(
  trx: Transaction<Database>,
  f: {
    date: string;
    pollId: string;
    kind: 'primary' | 'emergency_replacement';
    source: 'scheduled' | 'auto' | 'staff_pick';
    replaces?: string;
    actor: string | null;
    reason?: string;
    now: Date;
  },
) {
  await trx
    .updateTable('polls')
    .set({ status: 'live_daily', debut_et_date: f.date })
    .where('id', '=', f.pollId)
    .execute();
  await trx.deleteFrom('daily_schedule').where('poll_id', '=', f.pollId).execute();
  const row = await trx
    .insertInto('daily_features')
    .values({
      et_date: f.date,
      poll_id: f.pollId,
      kind: f.kind,
      source: f.source,
      replaces_feature_id: f.replaces ?? null,
      created_by: f.actor,
      reason: f.reason ?? null,
      started_at: f.now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const poll = await trx
    .selectFrom('polls')
    .select('creator_user_id')
    .where('id', '=', f.pollId)
    .executeTakeFirstOrThrow();
  if (poll.creator_user_id) {
    // Creator gets only the go-live notification, linking to answer their poll (spec §9, §18).
    await notify(trx, {
      userId: poll.creator_user_id,
      kind: 'poll_live',
      payload: { pollId: f.pollId, link: '/daily' },
      dedupeKey: `poll_live:${f.pollId}`,
      at: f.now,
    });
  }
  await audit(trx, {
    actor: f.actor,
    action: f.kind === 'primary' ? 'daily.publish' : 'daily.emergency_replace',
    targetType: 'poll',
    targetId: f.pollId,
    detail: { date: f.date, source: f.source, featureId: row.id, replaces: f.replaces ?? null },
  });
  return row.id;
}

async function recordEmptyQueue(
  trx: Transaction<Database>,
  date: string,
  kind: 'queue_empty' | 'emergency_no_replacement',
  now: Date,
) {
  await trx
    .insertInto('daily_poll_exceptions')
    .values({ et_date: date, kind, detail: JSON.stringify({}), created_at: now })
    .onConflict((oc) => oc.column('et_date').where('kind', '=', 'queue_empty').doNothing())
    .execute();
  await alertStaff(trx, {
    kind: 'staff_daily_queue_empty',
    payload: { date },
    dedupeKey: `${kind}:${date}`,
    at: now,
  });
  await audit(trx, { actor: null, action: `daily.${kind}`, targetType: 'daily', targetId: date });
}

export type PublishResult =
  | { status: 'published'; pollId: string }
  | { status: 'already_published' }
  | { status: 'unavailable' };

/**
 * The 12:00 AM America/New_York publication job (spec §2.4). Safe to run any number of times:
 * an advisory lock per date plus "one active feature per date" make it a no-op after the first success.
 * An empty queue never recycles or invents a poll: it records an exception and alerts staff.
 */
export async function publishDaily(deps: Db, now: Date): Promise<PublishResult> {
  const date = etDate(now);
  return deps.db.transaction().execute(async (trx) => {
    await lockDay(trx, date);
    await retireOldDailyPolls(trx, date, now);
    const today = await trx
      .selectFrom('daily_features')
      .select(['id', 'active'])
      .where('et_date', '=', date)
      .execute();
    if (today.some((f) => f.active)) return { status: 'already_published' };
    // A feature removed today without replacement stays unavailable; staff use emergency replace.
    if (today.length > 0) return { status: 'unavailable' };
    const pick = await pickPoll(trx, date);
    if (!pick) {
      await recordEmptyQueue(trx, date, 'queue_empty', now);
      return { status: 'unavailable' };
    }
    await feature(trx, {
      date,
      pollId: pick.id,
      kind: 'primary',
      source: pick.source,
      actor: null,
      now,
    });
    return { status: 'published', pollId: pick.id };
  });
}

/**
 * Emergency removal + replacement of today's Daily Poll (spec §2 edge cases, §23.6).
 * The original keeps its collected responses (removed, not deleted). The replacement must be an
 * untouched zero-response queued poll. Credit for people who already answered the original is
 * preserved by the survey milestone (M3) using `replaces_feature_id`.
 */
export async function emergencyReplace(
  deps: AppDeps,
  actorId: string,
  input: { reason: string; replacementPollId?: string },
): Promise<PublishResult> {
  const now = deps.clock();
  const date = etDate(now);
  return deps.db.transaction().execute(async (trx) => {
    await lockDay(trx, date);
    const current = await trx
      .selectFrom('daily_features')
      .select(['id', 'poll_id'])
      .where('et_date', '=', date)
      .where('active', '=', true)
      .forUpdate()
      .executeTakeFirst();
    if (!current)
      throw new AppError(
        409,
        'NO_ACTIVE_DAILY_POLL',
        'There is no active Daily Poll to replace today',
      );

    await trx
      .updateTable('daily_features')
      .set({ active: false, ended_at: now })
      .where('id', '=', current.id)
      .execute();
    await trx
      .updateTable('polls')
      .set({ status: 'removed', removed_at: now, removed_reason: input.reason })
      .where('id', '=', current.poll_id)
      .execute();
    await trx
      .insertInto('daily_poll_exceptions')
      .values({
        et_date: date,
        kind: 'emergency_removed',
        detail: JSON.stringify({ pollId: current.poll_id, actor: actorId }),
        created_at: now,
      })
      .execute();
    await audit(trx, {
      actor: actorId,
      action: 'daily.emergency_remove',
      targetType: 'poll',
      targetId: current.poll_id,
      detail: { date, reason: input.reason },
    });

    const pick = await pickPoll(trx, date, input.replacementPollId);
    if (!pick) {
      await recordEmptyQueue(trx, date, 'emergency_no_replacement', now);
      return { status: 'unavailable' };
    }
    await feature(trx, {
      date,
      pollId: pick.id,
      kind: 'emergency_replacement',
      source: pick.source,
      replaces: current.id,
      actor: actorId,
      reason: input.reason,
      now,
    });
    return { status: 'published', pollId: pick.id };
  });
}

/** Today's Daily Poll for members. Survey answering arrives in M3. */
export async function todaysDailyPoll(db: Kysely<Database>, now: Date) {
  const date = etDate(now);
  const row = await db
    .selectFrom('daily_features as f')
    .innerJoin('polls as p', 'p.id', 'f.poll_id')
    .leftJoin('users as u', 'u.id', 'p.creator_user_id')
    .leftJoin('profiles as pr', 'pr.user_id', 'p.creator_user_id')
    .select([
      'p.id',
      'p.text',
      'p.creator_visibility',
      'pr.username',
      'u.hide_name_on_polls',
      'u.state',
    ])
    .where('f.et_date', '=', date)
    .where('f.active', '=', true)
    .executeTakeFirst();
  if (!row)
    return {
      etDate: date,
      available: false as const,
      message: "Today's Daily Poll isn't available right now. Please check back later.",
    };
  return {
    etDate: date,
    available: true as const,
    poll: {
      id: row.id,
      text: row.text,
      creator: publicCreator({
        visibility: row.creator_visibility,
        username: row.username,
        hideAll: row.hide_name_on_polls,
        state: row.state,
      }),
    },
  };
}

// ---- Staff calendar (Owner/Admin) ----

function requireFutureDate(deps: AppDeps, date: string) {
  if (date <= etDate(deps.clock())) {
    throw new AppError(409, 'DATE_NOT_IN_FUTURE', 'Only upcoming days can be scheduled');
  }
}

export async function schedulePoll(deps: AppDeps, actorId: string, date: string, pollId: string) {
  requireFutureDate(deps, date);
  await deps.db.transaction().execute(async (trx) => {
    await lockDay(trx, date);
    const poll = await trx
      .selectFrom('polls')
      .select(['status', 'response_count'])
      .where('id', '=', pollId)
      .forUpdate()
      .executeTakeFirst();
    if (!poll) throw errors.notFound();
    if (poll.status !== 'queued' || poll.response_count !== 0) {
      throw new AppError(409, 'POLL_NOT_QUEUED', 'Only an untouched queued poll can be scheduled');
    }
    const elsewhere = await trx
      .selectFrom('daily_schedule')
      .select('et_date')
      .where('poll_id', '=', pollId)
      .executeTakeFirst();
    if (elsewhere && elsewhere.et_date !== date) {
      throw new AppError(
        409,
        'ALREADY_SCHEDULED',
        'That poll is already scheduled on another day',
        { date: elsewhere.et_date },
      );
    }
    const before = await trx
      .selectFrom('daily_schedule')
      .select('poll_id')
      .where('et_date', '=', date)
      .executeTakeFirst();
    await trx
      .insertInto('daily_schedule')
      .values({ et_date: date, poll_id: pollId, scheduled_by: actorId, scheduled_at: deps.clock() })
      .onConflict((oc) =>
        oc
          .column('et_date')
          .doUpdateSet({ poll_id: pollId, scheduled_by: actorId, scheduled_at: deps.clock() }),
      )
      .execute();
    await audit(trx, {
      actor: actorId,
      action: 'daily.schedule',
      targetType: 'daily',
      targetId: date,
      detail: { before: before?.poll_id ?? null, after: pollId },
    });
  });
}

export async function unschedule(deps: AppDeps, actorId: string, date: string) {
  requireFutureDate(deps, date);
  await deps.db.transaction().execute(async (trx) => {
    const r = await trx
      .deleteFrom('daily_schedule')
      .where('et_date', '=', date)
      .returning('poll_id')
      .executeTakeFirst();
    if (r)
      await audit(trx, {
        actor: actorId,
        action: 'daily.unschedule',
        targetType: 'daily',
        targetId: date,
        detail: { before: r.poll_id },
      });
  });
}

export async function calendarOverview(deps: AppDeps) {
  const today = etDate(deps.clock());
  const [schedule, queue, recent, exceptions] = await Promise.all([
    deps.db
      .selectFrom('daily_schedule as s')
      .innerJoin('polls as p', 'p.id', 's.poll_id')
      .select(['s.et_date as date', 'p.id as pollId', 'p.text'])
      .where('s.et_date', '>', today)
      .orderBy('s.et_date')
      .execute(),
    deps.db
      .selectFrom('polls')
      .select(['id', 'text', 'approved_at as approvedAt'])
      .where('status', '=', 'queued')
      .orderBy('approved_at')
      .execute(),
    deps.db
      .selectFrom('daily_features as f')
      .innerJoin('polls as p', 'p.id', 'f.poll_id')
      .select(['f.et_date as date', 'f.kind', 'f.source', 'f.active', 'p.id as pollId', 'p.text'])
      .orderBy('f.started_at', 'desc')
      .limit(30)
      .execute(),
    deps.db
      .selectFrom('daily_poll_exceptions')
      .select(['et_date as date', 'kind', 'created_at as at'])
      .orderBy('created_at', 'desc')
      .limit(30)
      .execute(),
  ]);
  return { today, queuedCount: queue.length, queue, schedule, recent, exceptions };
}
