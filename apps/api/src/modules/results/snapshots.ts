import type { Database } from '@pplpoll/db';
import { canonicalKeys, etDate, gameEligibility, GROUPING_VERSION } from '@pplpoll/domain';
import { sql, type Kysely } from 'kysely';
import { audit } from '../../core/audit.js';
import type { AppDeps } from '../../core/deps.js';
import { AppError, errors } from '../../core/errors.js';

const label = (canonicalKey: string) =>
  canonicalKey.charAt(0).toUpperCase() + canonicalKey.slice(1);

/**
 * Builds one immutable result snapshot for a poll (spec §4, §23.1). Only accepted genuine
 * responses count; removed responses drop out at the next snapshot.
 */
async function snapshotPoll(
  db: Kysely<Database>,
  pollId: string,
  date: string,
  now: Date,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`snapshot:${pollId}`}))`.execute(trx);
    const exists = await trx
      .selectFrom('result_snapshots')
      .select('id')
      .where('poll_id', '=', pollId)
      .where('et_date', '=', date)
      .executeTakeFirst();
    if (exists) return false;

    const rows = await trx
      .selectFrom('survey_responses')
      .select(['normalized_key', (eb) => eb.fn.countAll<string>().as('n')])
      .where('poll_id', '=', pollId)
      .where('status', '=', 'accepted')
      .groupBy('normalized_key')
      .execute();
    const aliases = await trx
      .selectFrom('answer_aliases')
      .select(['normalized_key', 'canonical_key'])
      .where('poll_id', '=', pollId)
      .execute();
    const aliasMap = new Map(aliases.map((a) => [a.normalized_key, a.canonical_key]));
    const canonical = canonicalKeys(
      rows.map((r) => r.normalized_key),
      aliasMap,
    );

    const groupCounts = new Map<string, number>();
    for (const r of rows) {
      const c = canonical.get(r.normalized_key)!;
      groupCounts.set(c, (groupCounts.get(c) ?? 0) + Number(r.n));
    }
    for (const c of groupCounts.keys()) {
      await trx
        .insertInto('answer_groups')
        .values({ poll_id: pollId, canonical_key: c, label: label(c), created_at: now })
        .onConflict((oc) => oc.columns(['poll_id', 'canonical_key']).doNothing())
        .execute();
    }
    const groups = groupCounts.size
      ? await trx
          .selectFrom('answer_groups')
          .select(['id', 'canonical_key', 'label'])
          .where('poll_id', '=', pollId)
          .where('canonical_key', 'in', [...groupCounts.keys()])
          .execute()
      : [];
    const idOf = new Map(groups.map((g) => [g.canonical_key, g.id]));

    const distribution: Record<string, number> = {};
    const labels: Record<string, string> = {};
    for (const g of groups) {
      distribution[g.id] = groupCounts.get(g.canonical_key)!;
      labels[g.id] = g.label;
    }
    const keymap: Record<string, string> = {};
    for (const [key, c] of canonical) keymap[key] = idOf.get(c)!;
    for (const [key, c] of aliasMap) if (idOf.has(c)) keymap[key] = idOf.get(c)!;
    for (const c of groupCounts.keys()) keymap[c] = idOf.get(c)!;

    const respondents = Object.values(distribution).reduce((a, b) => a + b, 0);
    const el = gameEligibility(Object.values(distribution), respondents);
    const prev = await trx
      .selectFrom('result_snapshots')
      .select((eb) => eb.fn.max('version').as('v'))
      .where('poll_id', '=', pollId)
      .executeTakeFirst();
    await trx
      .insertInto('result_snapshots')
      .values({
        poll_id: pollId,
        et_date: date,
        version: Number(prev?.v ?? 0) + 1,
        respondents,
        k: el.k,
        guess_cap: el.eligible ? el.cap : null,
        eligible: el.eligible,
        ineligible_reason: el.eligible ? null : el.reason,
        distribution: JSON.stringify(distribution),
        keymap: JSON.stringify(keymap),
        labels: JSON.stringify(labels),
        grouping_version: GROUPING_VERSION,
        computed_at: now,
      })
      .execute();
    return true;
  });
}

/**
 * The 24-hour snapshot job: one new snapshot per poll per America/New_York day. Idempotent;
 * safe to run repeatedly. Games already in progress keep the snapshot they started with.
 */
export async function computeSnapshots(deps: Pick<AppDeps, 'db'>, now: Date): Promise<number> {
  const date = etDate(now);
  const polls = await deps.db
    .selectFrom('polls as p')
    .select('p.id')
    .where('p.status', 'in', ['survey', 'live_daily'])
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('result_snapshots as s')
            .select('s.id')
            .whereRef('s.poll_id', '=', 'p.id')
            .where('s.et_date', '=', date),
        ),
      ),
    )
    .execute();
  let made = 0;
  for (const p of polls) if (await snapshotPoll(deps.db, p.id, date, now)) made++;
  return made;
}

// ---- Staff answer grouping (moderator+) ----

/** Normalized answer keys and counts for staff grouping. Raw text is not exposed here. */
export async function answerKeysForStaff(deps: AppDeps, actorId: string, pollId: string) {
  const poll = await deps.db
    .selectFrom('polls')
    .select('status')
    .where('id', '=', pollId)
    .executeTakeFirst();
  if (!poll) throw errors.notFound();
  const rows = await deps.db
    .selectFrom('survey_responses')
    .select(['normalized_key as key', (eb) => eb.fn.countAll<string>().as('n')])
    .where('poll_id', '=', pollId)
    .where('status', '=', 'accepted')
    .groupBy('normalized_key')
    .orderBy('n', 'desc')
    .execute();
  const aliases = await deps.db
    .selectFrom('answer_aliases')
    .select(['normalized_key', 'canonical_key'])
    .where('poll_id', '=', pollId)
    .execute();
  const canonical = canonicalKeys(
    rows.map((r) => r.key),
    new Map(aliases.map((a) => [a.normalized_key, a.canonical_key])),
  );
  await audit(deps.db, {
    actor: actorId,
    action: 'poll.view_answer_keys',
    targetType: 'poll',
    targetId: pollId,
  });
  return rows.map((r) => ({ key: r.key, count: Number(r.n), group: canonical.get(r.key)! }));
}

/** Merge answer keys into one group (synonyms / spellings). Takes effect at the next snapshot. */
export async function mergeAnswerKeys(
  deps: AppDeps,
  actorId: string,
  pollId: string,
  keys: string[],
  into: string,
) {
  if (keys.includes(into))
    throw new AppError(400, 'VALIDATION_FAILED', 'A key cannot be merged into itself', {
      fields: ['keys'],
    });
  await deps.db.transaction().execute(async (trx) => {
    const poll = await trx
      .selectFrom('polls')
      .select('id')
      .where('id', '=', pollId)
      .executeTakeFirst();
    if (!poll) throw errors.notFound();
    for (const k of keys) {
      await trx
        .insertInto('answer_aliases')
        .values({
          poll_id: pollId,
          normalized_key: k,
          canonical_key: into,
          created_by: actorId,
          created_at: deps.clock(),
        })
        .onConflict((oc) =>
          oc
            .columns(['poll_id', 'normalized_key'])
            .doUpdateSet({ canonical_key: into, created_by: actorId }),
        )
        .execute();
    }
    await audit(trx, {
      actor: actorId,
      action: 'poll.merge_answers',
      targetType: 'poll',
      targetId: pollId,
      detail: { keys, into },
    });
  });
}
