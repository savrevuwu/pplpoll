import type { Database } from '@pplpoll/db';
import { addEtDays } from '@pplpoll/domain';
import type { Kysely, Transaction } from 'kysely';

export type StreakKind = 'answering' | 'guessing';

/**
 * Two independent daily streaks (spec §17, §23.5). Called once on the day the streak's target
 * is met; a second call for the same day is a no-op. Missing a day restarts at 1.
 */
export async function advanceStreak(
  trx: Transaction<Database>,
  userId: string,
  kind: StreakKind,
  date: string,
): Promise<void> {
  const row = await trx
    .selectFrom('streaks')
    .select(['current', 'longest', 'last_et_date'])
    .where('user_id', '=', userId)
    .where('kind', '=', kind)
    .forUpdate()
    .executeTakeFirst();
  if (row?.last_et_date === date) return;
  const current = row?.last_et_date === addEtDays(date, -1) ? row.current + 1 : 1;
  const longest = Math.max(row?.longest ?? 0, current);
  await trx
    .insertInto('streaks')
    .values({ user_id: userId, kind, current, longest, last_et_date: date })
    .onConflict((oc) =>
      oc.columns(['user_id', 'kind']).doUpdateSet({ current, longest, last_et_date: date }),
    )
    .execute();
}

/** Current streak as shown today: it stays alive until the end of the day after it last advanced. */
export async function readStreaks(db: Kysely<Database>, userId: string, today: string) {
  const rows = await db.selectFrom('streaks').selectAll().where('user_id', '=', userId).execute();
  const view = (kind: StreakKind) => {
    const r = rows.find((x) => x.kind === kind);
    if (!r) return { current: 0, longest: 0, lastDate: null };
    const alive = r.last_et_date === today || r.last_et_date === addEtDays(today, -1);
    return { current: alive ? r.current : 0, longest: r.longest, lastDate: r.last_et_date };
  };
  return { answering: view('answering'), guessing: view('guessing') };
}
