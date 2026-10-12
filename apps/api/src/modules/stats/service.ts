import type { Database } from '@pplpoll/db';
import { formatPercent, recordHolders, share } from '@pplpoll/domain';
import type { Kysely } from 'kysely';

/**
 * Sitewide Rarest Guess Record (update §9): everyone tied at the lowest legitimate share holds the
 * badge. Computed from personal records, so a new lower share moves the badge automatically and
 * an invalidated record (removed from player_rarest by moderation) recomputes it.
 * Only the percentage is ever shown — never the poll or the answer.
 */
export async function rarestRecord(db: Kysely<Database>) {
  const rows = await db
    .selectFrom('player_rarest')
    .select(['user_id', 'share_count', 'share_total'])
    .execute();
  const r = recordHolders(
    rows.map((x) => ({ userId: x.user_id, share: share(x.share_count, x.share_total) })),
  );
  if (!r) return null;
  const names = await db
    .selectFrom('profiles as p')
    .innerJoin('users as u', 'u.id', 'p.user_id')
    .select(['p.user_id', 'p.username'])
    .where('p.user_id', 'in', r.userIds)
    .where('u.state', '=', 'active')
    .execute();
  return {
    percent: formatPercent(r.share),
    holderIds: r.userIds,
    holders: names.map((n) => n.username).sort(),
  };
}

export async function playerStats(db: Kysely<Database>, userId: string) {
  const solo = await db
    .selectFrom('games')
    .select(['outcome', (eb) => eb.fn.countAll<string>().as('n')])
    .where('user_id', '=', userId)
    .where('mode', '=', 'solo')
    .where('valid', '=', true)
    .where('state', '=', 'ended')
    .groupBy('outcome')
    .execute();
  const count = (o: string) => Number(solo.find((s) => s.outcome === o)?.n ?? 0);
  const accuracy = await db
    .selectFrom('guesses as g')
    .innerJoin('games as gm', 'gm.id', 'g.game_id')
    .select([
      (eb) => eb.fn.countAll<string>().filterWhere('g.result', '=', 'correct').as('correct'),
      (eb) => eb.fn.countAll<string>().filterWhere('g.result', '!=', 'duplicate').as('accepted'),
    ])
    .where('g.submitted_by', '=', userId)
    .where('gm.valid', '=', true)
    .where('gm.outcome', 'in', ['won', 'lost'])
    .executeTakeFirstOrThrow();
  const rarest = await db
    .selectFrom('player_rarest')
    .select(['share_count', 'share_total'])
    .where('user_id', '=', userId)
    .executeTakeFirst();
  const record = await rarestRecord(db);
  return {
    solo: {
      gamesPlayed: count('won') + count('lost'),
      wins: count('won'),
      losses: count('lost'),
      correctGuesses: Number(accuracy.correct),
      acceptedGuesses: Number(accuracy.accepted),
    },
    rarestCorrectGuess: rarest
      ? formatPercent(share(rarest.share_count, rarest.share_total))
      : null,
    rarestGuessRecordHolder: record?.holderIds.includes(userId) ?? false,
  };
}
