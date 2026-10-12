import type { Database } from '@pplpoll/db';
import { compareShares, etDate, isRarer, share, type Share } from '@pplpoll/domain';
import type { Kysely, Transaction } from 'kysely';
import { advanceStreak } from '../streaks/service.js';

type Trx = Transaction<Database>;

/** 10 charged guessing games per ET day, shared by solo, Mystery and every multiplayer mode (§23.3). */
export const DAILY_GAME_LIMIT = 10;

export async function chargedOn(
  db: Trx | Kysely<Database>,
  userId: string,
  date: string,
): Promise<number> {
  const r = await db
    .selectFrom('daily_charges')
    .select('charged')
    .where('user_id', '=', userId)
    .where('et_date', '=', date)
    .executeTakeFirst();
  return r?.charged ?? 0;
}

export async function reserve(
  trx: Trx,
  userId: string,
  participationId: string,
  now: Date,
): Promise<void> {
  await trx
    .insertInto('allowance_events')
    .values({
      user_id: userId,
      participation_id: participationId,
      kind: 'reserve',
      et_date: etDate(now),
      at: now,
    })
    .execute();
}

/**
 * Charges one daily game at the participant's first accepted guess, by the ET date of that guess,
 * marks the poll played, and advances the guessing streak on the day's 10th charge.
 * Idempotent per participation. Returns false when that day is already full.
 */
export async function chargeParticipant(
  trx: Trx,
  p: { userId: string; participationId: string; pollId: string; snapshotId: string; now: Date },
): Promise<boolean> {
  const part = await trx
    .selectFrom('game_participations')
    .select('first_guess_at')
    .where('id', '=', p.participationId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (part.first_guess_at) return true;
  const date = etDate(p.now);
  const charged = await trx
    .insertInto('daily_charges')
    .values({ user_id: p.userId, et_date: date, charged: 1 })
    .onConflict((oc) =>
      oc
        .columns(['user_id', 'et_date'])
        .doUpdateSet((eb) => ({ charged: eb('daily_charges.charged', '+', 1) }))
        .where('daily_charges.charged', '<', DAILY_GAME_LIMIT),
    )
    .returning('charged')
    .executeTakeFirst();
  if (!charged) return false;
  await trx
    .insertInto('allowance_events')
    .values({
      user_id: p.userId,
      participation_id: p.participationId,
      kind: 'charge',
      et_date: date,
      at: p.now,
    })
    .execute();
  await trx
    .updateTable('game_participations')
    .set({ first_guess_at: p.now, charge_et_date: date })
    .where('id', '=', p.participationId)
    .execute();
  // First accepted guess marks the poll played (§5, §23.2).
  await trx
    .insertInto('played_polls')
    .values({
      user_id: p.userId,
      poll_id: p.pollId,
      first_played_at: p.now,
      last_played_at: p.now,
      last_snapshot_id: p.snapshotId,
    })
    .onConflict((oc) =>
      oc.columns(['user_id', 'poll_id']).doUpdateSet((eb) => ({
        last_played_at: p.now,
        last_snapshot_id: p.snapshotId,
        plays: eb('played_polls.plays', '+', 1),
      })),
    )
    .execute();
  if (charged.charged === DAILY_GAME_LIMIT) await advanceStreak(trx, p.userId, 'guessing', date);
  return true;
}

/** Ends a participation; one with no accepted guess is released with no charge. */
export async function endParticipationRow(
  trx: Trx,
  participationId: string,
  userId: string,
  now: Date,
): Promise<void> {
  const part = await trx
    .updateTable('game_participations')
    .set({ active: false, ended_at: now })
    .where('id', '=', participationId)
    .returning(['first_guess_at'])
    .executeTakeFirstOrThrow();
  if (!part.first_guess_at) {
    await trx
      .insertInto('allowance_events')
      .values({
        user_id: userId,
        participation_id: participationId,
        kind: 'release',
        et_date: etDate(now),
        at: now,
      })
      .onConflict((oc) => oc.columns(['participation_id', 'kind']).doNothing())
      .execute();
  }
}

/** Personal Rarest Correct Guess (update §8): keeps the strictly lowest frozen share. */
export async function recordRarest(
  trx: Trx,
  userId: string,
  correct: readonly { guessId: string; count: number; total: number; at: Date }[],
  source: 'game' | 'match',
): Promise<void> {
  let best: { id: string; s: Share; at: Date } | null = null;
  for (const c of correct) {
    const s = share(c.count, c.total);
    if (!best || compareShares(s, best.s) < 0) best = { id: c.guessId, s, at: c.at };
  }
  if (!best) return;
  const current = await trx
    .selectFrom('player_rarest')
    .selectAll()
    .where('user_id', '=', userId)
    .forUpdate()
    .executeTakeFirst();
  if (!isRarer(best.s, current ? share(current.share_count, current.share_total) : null)) return;
  const values = {
    share_count: best.s.count,
    share_total: best.s.total,
    guess_id: best.id,
    guess_source: source,
    achieved_at: best.at,
  };
  await trx
    .insertInto('player_rarest')
    .values({ user_id: userId, ...values })
    .onConflict((oc) => oc.column('user_id').doUpdateSet(values))
    .execute();
}
