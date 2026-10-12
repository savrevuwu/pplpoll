import type { Database } from '@pplpoll/db';
import type { Kysely, Transaction } from 'kysely';

/**
 * In-app notifications (spec §18). Payloads never contain other people's private data,
 * answer distributions or moderation evidence.
 */
export async function notify(
  trx: Transaction<Database> | Kysely<Database>,
  n: {
    userId: string;
    kind: string;
    payload?: Record<string, unknown>;
    dedupeKey?: string;
    at: Date;
  },
): Promise<void> {
  await trx
    .insertInto('notifications')
    .values({
      user_id: n.userId,
      kind: n.kind,
      dedupe_key: n.dedupeKey ?? null,
      payload: JSON.stringify(n.payload ?? {}),
      created_at: n.at,
    })
    .onConflict((oc) => oc.column('dedupe_key').doNothing())
    .execute();
}

/** Alerts every active Admin and the Owner (e.g. empty Daily Poll queue). */
export async function alertStaff(
  trx: Transaction<Database>,
  alert: { kind: string; payload: Record<string, unknown>; dedupeKey: string; at: Date },
): Promise<void> {
  const staff = await trx
    .selectFrom('users')
    .select('id')
    .where('role', 'in', ['admin', 'owner'])
    .where('state', '=', 'active')
    .execute();
  for (const s of staff) {
    await notify(trx, {
      userId: s.id,
      kind: alert.kind,
      payload: alert.payload,
      dedupeKey: `${alert.dedupeKey}:${s.id}`,
      at: alert.at,
    });
  }
}

export async function listNotifications(db: Kysely<Database>, userId: string) {
  return db
    .selectFrom('notifications')
    .select(['id', 'kind', 'payload', 'created_at as createdAt', 'read_at as readAt'])
    .where('user_id', '=', userId)
    .orderBy('created_at', 'desc')
    .limit(100)
    .execute();
}

export async function markRead(
  db: Kysely<Database>,
  userId: string,
  id: string,
  at: Date,
): Promise<boolean> {
  const r = await db
    .updateTable('notifications')
    .set({ read_at: at })
    .where('id', '=', id)
    .where('user_id', '=', userId)
    .where('read_at', 'is', null)
    .executeTakeFirst();
  return r.numUpdatedRows > 0n;
}
