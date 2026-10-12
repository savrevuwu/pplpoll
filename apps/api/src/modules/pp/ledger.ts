import type { Database } from '@pplpoll/db';
import type { Kysely, Transaction } from 'kysely';
import { AppError } from '../../core/errors.js';

type Kind = Database['pp_ledger']['kind'];

/**
 * Poll Points (spec §3, §9). The balance row is changed in the same transaction as the
 * append-only ledger entry, and can never go below zero (DB CHECK + guarded UPDATE).
 */
export async function creditPp(
  trx: Transaction<Database>,
  entry: {
    userId: string;
    kind: Kind;
    refId?: string | undefined;
    etDate?: string | undefined;
    actor?: string | undefined;
    at: Date;
  },
): Promise<void> {
  await trx
    .insertInto('pp_accounts')
    .values({ user_id: entry.userId, balance: 1 })
    .onConflict((oc) =>
      oc.column('user_id').doUpdateSet((eb) => ({ balance: eb('pp_accounts.balance', '+', 1) })),
    )
    .execute();
  await trx
    .insertInto('pp_ledger')
    .values({
      user_id: entry.userId,
      delta: 1,
      kind: entry.kind,
      ref_id: entry.refId ?? null,
      et_date: entry.etDate ?? null,
      actor_user_id: entry.actor ?? null,
      created_at: entry.at,
    })
    .execute();
}

export const ppInsufficient = () =>
  new AppError(402, 'PP_INSUFFICIENT', 'You need 1 Poll Point to do that');

export async function debitPp(
  trx: Transaction<Database>,
  entry: {
    userId: string;
    kind: Kind;
    refId?: string | undefined;
    actor?: string | undefined;
    at: Date;
  },
): Promise<void> {
  const res = await trx
    .updateTable('pp_accounts')
    .set((eb) => ({ balance: eb('balance', '-', 1) }))
    .where('user_id', '=', entry.userId)
    .where('balance', '>=', 1)
    .executeTakeFirst();
  if (res.numUpdatedRows === 0n) throw ppInsufficient();
  await trx
    .insertInto('pp_ledger')
    .values({
      user_id: entry.userId,
      delta: -1,
      kind: entry.kind,
      ref_id: entry.refId ?? null,
      et_date: null,
      actor_user_id: entry.actor ?? null,
      created_at: entry.at,
    })
    .execute();
}

export async function ppSummary(db: Kysely<Database>, userId: string) {
  const account = await db
    .selectFrom('pp_accounts')
    .select('balance')
    .where('user_id', '=', userId)
    .executeTakeFirst();
  const ledger = await db
    .selectFrom('pp_ledger')
    .select(['delta', 'kind', 'ref_id as refId', 'et_date as etDate', 'created_at as at'])
    .where('user_id', '=', userId)
    .orderBy('created_at', 'desc')
    .limit(50)
    .execute();
  return { balance: account?.balance ?? 0, ledger };
}
