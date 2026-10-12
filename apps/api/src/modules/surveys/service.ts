import type { Database } from '@pplpoll/db';
import {
  ANSWER_NORMALIZATION_VERSION,
  checkAnswer,
  DAILY_REGULAR_SLOTS,
  DAILY_TARGET,
  etDate,
} from '@pplpoll/domain';
import { sql, type Transaction } from 'kysely';
import { audit } from '../../core/audit.js';
import type { AppDeps } from '../../core/deps.js';
import { AppError, isUniqueViolation } from '../../core/errors.js';
import { notify } from '../notifications/service.js';
import { publicCreator } from '../polls/attribution.js';
import { advanceStreak } from '../streaks/service.js';

type Trx = Transaction<Database>;

const THANK_YOU = 'Thank you for your response';

const rejected = (reason: string) =>
  new AppError(422, 'RESPONSE_REJECTED', 'Please enter a real answer to the question', { reason });
const rolledOver = () =>
  new AppError(409, 'DAY_ROLLED_OVER', "A new day has started. Here are today's surveys");
const unavailable = () =>
  new AppError(409, 'DAILY_POLL_UNAVAILABLE', "Today's Daily Poll isn't available right now");

/** Serializes all answering for one person and day so progress and the PP award can't race. */
async function lockUserDay(trx: Trx, userId: string, date: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`answer:${userId}:${date}`}))`.execute(trx);
}

async function identityOf(trx: Trx, userId: string): Promise<string> {
  const r = await trx
    .selectFrom('user_participation_identity')
    .select('participation_identity_id')
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
  return r.participation_identity_id;
}

async function activeFeature(trx: Trx, date: string) {
  return trx
    .selectFrom('daily_features')
    .select(['id', 'poll_id'])
    .where('et_date', '=', date)
    .where('active', '=', true)
    .executeTakeFirst();
}

/**
 * Fills today's 10 regular survey slots with existing polls this person has never answered (§3).
 * Empty slots are topped up on later visits; if the pool is smaller than 10, fewer are assigned
 * and the day cannot be completed — no credit is invented.
 */
async function ensureAssignments(
  trx: Trx,
  userId: string,
  identityId: string,
  date: string,
  now: Date,
) {
  const existing = await trx
    .selectFrom('daily_assignments')
    .select(['slot', 'poll_id'])
    .where('user_id', '=', userId)
    .where('et_date', '=', date)
    .execute();
  const free = Array.from({ length: DAILY_REGULAR_SLOTS }, (_, i) => i + 1).filter(
    (s) => !existing.some((e) => e.slot === s),
  );
  if (free.length === 0) return;
  const picks = await trx
    .selectFrom('polls as p')
    .select('p.id')
    .where('p.status', '=', 'survey')
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('survey_responses as r')
            .select('r.id')
            .whereRef('r.poll_id', '=', 'p.id')
            .where('r.participation_identity_id', '=', identityId),
        ),
      ),
    )
    .$if(existing.length > 0, (qb) =>
      qb.where(
        'p.id',
        'not in',
        existing.map((e) => e.poll_id),
      ),
    )
    .orderBy(sql`random()`)
    .limit(free.length)
    .execute();
  if (picks.length === 0) return;
  await trx
    .insertInto('daily_assignments')
    .values(
      picks.map((p, i) => ({
        user_id: userId,
        et_date: date,
        slot: free[i]!,
        poll_id: p.id,
        created_at: now,
      })),
    )
    .execute();
}

async function progressOf(trx: Trx, userId: string, date: string): Promise<number> {
  const r = await trx
    .selectFrom('survey_responses')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('user_id', '=', userId)
    .where('et_date', '=', date)
    .where('counts_for_progress', '=', true)
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

/** Exactly one PP per completed day, ever (§3, AT-05): ledger unique index + same-transaction balance update. */
async function awardIfComplete(
  trx: Trx,
  userId: string,
  date: string,
  now: Date,
): Promise<boolean> {
  if ((await progressOf(trx, userId, date)) < DAILY_TARGET) return false;
  const inserted = await trx
    .insertInto('pp_ledger')
    .values({
      user_id: userId,
      delta: 1,
      kind: 'daily_award',
      ref_id: null,
      et_date: date,
      actor_user_id: null,
      created_at: now,
    })
    .onConflict((oc) =>
      oc.columns(['user_id', 'et_date']).where('kind', '=', 'daily_award').doNothing(),
    )
    .returning('id')
    .executeTakeFirst();
  if (!inserted) return false;
  await trx
    .insertInto('pp_accounts')
    .values({ user_id: userId, balance: 1 })
    .onConflict((oc) =>
      oc.column('user_id').doUpdateSet((eb) => ({ balance: eb('pp_accounts.balance', '+', 1) })),
    )
    .execute();
  await advanceStreak(trx, userId, 'answering', date);
  await notify(trx, {
    userId,
    kind: 'pp_awarded',
    payload: { date },
    dedupeKey: `pp_awarded:${userId}:${date}`,
    at: now,
  });
  await audit(trx, {
    actor: userId,
    action: 'pp.daily_award',
    targetType: 'user',
    targetId: userId,
    detail: { date },
  });
  return true;
}

interface Accept {
  userId: string;
  identityId: string;
  pollId: string;
  date: string;
  text: string;
  key: string;
  countsForProgress: boolean;
  dailyFeatureId?: string;
  slot?: number;
  now: Date;
}

async function insertResponse(trx: Trx, deps: AppDeps, a: Accept): Promise<string> {
  try {
    const row = await trx
      .insertInto('survey_responses')
      .values({
        poll_id: a.pollId,
        participation_identity_id: a.identityId,
        user_id: a.userId,
        et_date: a.date,
        context: a.dailyFeatureId ? 'daily_poll' : 'assignment',
        daily_feature_id: a.dailyFeatureId ?? null,
        assignment_slot: a.slot ?? null,
        counts_for_progress: a.countsForProgress,
        normalized_key: a.key,
        normalization_version: ANSWER_NORMALIZATION_VERSION,
        answer_group_id: null,
        submitted_at: a.now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('survey_response_raw')
      .values({ response_id: row.id, raw_text_enc: deps.crypto.encrypt(a.text) })
      .execute();
    await trx
      .updateTable('polls')
      .set((eb) => ({ response_count: eb('response_count', '+', 1) }))
      .where('id', '=', a.pollId)
      .execute();
    return row.id;
  } catch (err) {
    if (isUniqueViolation(err))
      throw new AppError(409, 'ALREADY_ANSWERED', 'You already answered this survey');
    if (typeof err === 'object' && err && (err as { code?: string }).code === '23514') {
      throw new AppError(409, 'POLL_UNAVAILABLE', 'This survey is no longer available');
    }
    throw err;
  }
}

export interface AnswerResult {
  status: 'accepted';
  message: string;
  alreadyAnswered: boolean;
  countsForProgress: boolean;
  progress: { completed: number; target: number };
  ppAwarded: boolean;
}

async function result(
  trx: Trx,
  userId: string,
  date: string,
  r: { already: boolean; counts: boolean; awarded: boolean },
): Promise<AnswerResult> {
  return {
    status: 'accepted',
    message: THANK_YOU,
    alreadyAnswered: r.already,
    countsForProgress: r.counts,
    progress: { completed: await progressOf(trx, userId, date), target: DAILY_TARGET },
    ppAwarded: r.awarded,
  };
}

/**
 * Answer today's Daily Poll. `pollId` is the poll the person was shown, so a midnight rollover
 * or an emergency replacement is detected instead of silently answering a different question.
 * Emergency replacement (§23.6): if they already answered the removed original today, their
 * credit stays and the replacement answer is optional and doesn't add progress.
 */
export async function answerDailyPoll(
  deps: AppDeps,
  userId: string,
  pollId: string,
  input: string,
): Promise<AnswerResult> {
  const check = checkAnswer(input);
  if (!check.ok) throw rejected(check.reason);
  const now = deps.clock();
  const date = etDate(now);
  return deps.db.transaction().execute(async (trx) => {
    await lockUserDay(trx, userId, date);
    const feature = await activeFeature(trx, date);
    if (!feature) throw unavailable();
    if (feature.poll_id !== pollId) throw rolledOver();
    const identityId = await identityOf(trx, userId);
    const prior = await trx
      .selectFrom('survey_responses')
      .select(['counts_for_progress', 'user_id'])
      .where('poll_id', '=', pollId)
      .where('participation_identity_id', '=', identityId)
      .executeTakeFirst();
    if (prior)
      return result(trx, userId, date, {
        already: true,
        // An answer given from an earlier (deleted) account never counts for this account.
        counts: prior.user_id === userId && prior.counts_for_progress,
        awarded: false,
      });

    const alreadyCredited = await trx
      .selectFrom('survey_responses')
      .select('id')
      .where('user_id', '=', userId)
      .where('et_date', '=', date)
      .where('context', '=', 'daily_poll')
      .where('counts_for_progress', '=', true)
      .executeTakeFirst();
    const counts = !alreadyCredited;
    await insertResponse(trx, deps, {
      userId,
      identityId,
      pollId,
      date,
      text: check.text,
      key: check.key,
      countsForProgress: counts,
      dailyFeatureId: feature.id,
      now,
    });
    const awarded = counts ? await awardIfComplete(trx, userId, date, now) : false;
    return result(trx, userId, date, { already: false, counts, awarded });
  });
}

/** Answer one of today's 10 assigned existing surveys. */
export async function answerAssignment(
  deps: AppDeps,
  userId: string,
  slot: number,
  pollId: string,
  input: string,
): Promise<AnswerResult> {
  const check = checkAnswer(input);
  if (!check.ok) throw rejected(check.reason);
  const now = deps.clock();
  const date = etDate(now);
  return deps.db.transaction().execute(async (trx) => {
    await lockUserDay(trx, userId, date);
    const a = await trx
      .selectFrom('daily_assignments')
      .select(['poll_id', 'response_id'])
      .where('user_id', '=', userId)
      .where('et_date', '=', date)
      .where('slot', '=', slot)
      .executeTakeFirst();
    if (!a || a.poll_id !== pollId) throw rolledOver();
    if (a.response_id)
      return result(trx, userId, date, { already: true, counts: true, awarded: false });
    const identityId = await identityOf(trx, userId);
    const responseId = await insertResponse(trx, deps, {
      userId,
      identityId,
      pollId,
      date,
      text: check.text,
      key: check.key,
      countsForProgress: true,
      slot,
      now,
    });
    await trx
      .updateTable('daily_assignments')
      .set({ response_id: responseId })
      .where('user_id', '=', userId)
      .where('et_date', '=', date)
      .where('slot', '=', slot)
      .execute();
    const awarded = await awardIfComplete(trx, userId, date, now);
    return result(trx, userId, date, { already: false, counts: true, awarded });
  });
}

/** Today's survey page: Daily Poll, assigned surveys, progress, PP status, announcement and reminder flags. */
export async function getDaily(deps: AppDeps, userId: string) {
  const now = deps.clock();
  const date = etDate(now);
  return deps.db.transaction().execute(async (trx) => {
    await lockUserDay(trx, userId, date);
    const identityId = await identityOf(trx, userId);
    await ensureAssignments(trx, userId, identityId, date, now);

    const feature = await trx
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
    const dailyResponses = await trx
      .selectFrom('survey_responses')
      .select(['poll_id', 'counts_for_progress'])
      .where('user_id', '=', userId)
      .where('et_date', '=', date)
      .where('context', '=', 'daily_poll')
      .execute();
    const credited = dailyResponses.some((r) => r.counts_for_progress);

    const assignments = await trx
      .selectFrom('daily_assignments as a')
      .innerJoin('polls as p', 'p.id', 'a.poll_id')
      .select(['a.slot', 'p.id', 'p.text', 'a.response_id'])
      .where('a.user_id', '=', userId)
      .where('a.et_date', '=', date)
      .orderBy('a.slot')
      .execute();
    const completed = await progressOf(trx, userId, date);
    const awarded = await trx
      .selectFrom('pp_ledger')
      .select('id')
      .where('user_id', '=', userId)
      .where('et_date', '=', date)
      .where('kind', '=', 'daily_award')
      .executeTakeFirst();
    const charges = await trx
      .selectFrom('daily_charges')
      .select('charged')
      .where('user_id', '=', userId)
      .where('et_date', '=', date)
      .executeTakeFirst();
    const guessesUsed = charges?.charged ?? 0;
    const settings = await trx
      .selectFrom('notification_settings')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirst();
    const seen = await trx
      .selectFrom('daily_announcement_seen')
      .select('et_date')
      .where('user_id', '=', userId)
      .where('et_date', '=', date)
      .executeTakeFirst();

    const answeredDailyPoll = feature
      ? dailyResponses.some((r) => r.poll_id === feature.id)
      : false;
    return {
      etDate: date,
      dailyPoll: feature
        ? {
            available: true as const,
            poll: {
              id: feature.id,
              text: feature.text,
              creator: publicCreator({
                visibility: feature.creator_visibility,
                username: feature.username,
                hideAll: feature.hide_name_on_polls,
                state: feature.state,
              }),
            },
            answered: answeredDailyPoll,
            // Emergency replacement: earlier credit is kept; answering the replacement is optional.
            optional: credited && !answeredDailyPoll,
          }
        : { available: false as const, credited },
      assignments: assignments.map((a) => ({
        slot: a.slot,
        poll: { id: a.id, text: a.text },
        answered: a.response_id !== null,
      })),
      progress: {
        completed,
        target: DAILY_TARGET,
        possible: (feature || credited ? 1 : 0) + assignments.length,
      },
      ppAwarded: Boolean(awarded),
      announcement: {
        show: Boolean(feature) && (settings?.daily_poll_announcement ?? true) && !seen,
      },
      reminders: {
        answering: (settings?.answering_reminder ?? false) && completed < DAILY_TARGET,
        guessing: (settings?.guessing_reminder ?? false) && guessesUsed < 10,
      },
    };
  });
}

export async function markAnnouncementSeen(deps: AppDeps, userId: string) {
  await deps.db
    .insertInto('daily_announcement_seen')
    .values({ user_id: userId, et_date: etDate(deps.clock()) })
    .onConflict((oc) => oc.columns(['user_id', 'et_date']).doNothing())
    .execute();
}

export async function getNotificationSettings(deps: AppDeps, userId: string) {
  const s = await deps.db
    .selectFrom('notification_settings')
    .selectAll()
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return {
    dailyPollAnnouncement: s?.daily_poll_announcement ?? true,
    answeringReminder: s?.answering_reminder ?? false,
    guessingReminder: s?.guessing_reminder ?? false,
  };
}

export async function setNotificationSettings(
  deps: AppDeps,
  userId: string,
  input: Partial<{
    dailyPollAnnouncement: boolean;
    answeringReminder: boolean;
    guessingReminder: boolean;
  }>,
) {
  const current = await getNotificationSettings(deps, userId);
  const next = { ...current, ...input };
  const values = {
    daily_poll_announcement: next.dailyPollAnnouncement,
    answering_reminder: next.answeringReminder,
    guessing_reminder: next.guessingReminder,
  };
  await deps.db
    .insertInto('notification_settings')
    .values({ user_id: userId, ...values })
    .onConflict((oc) => oc.column('user_id').doUpdateSet(values))
    .execute();
  return next;
}
