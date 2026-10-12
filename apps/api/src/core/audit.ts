import type { Database } from '@pplpoll/db';
import type { Kysely, Transaction } from 'kysely';

/** Appends to the immutable audit log. Callers pass a transaction so the record commits with the change. */
export async function audit(
  db: Kysely<Database> | Transaction<Database>,
  entry: {
    actor: string | null;
    action: string;
    targetType?: string;
    targetId?: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .insertInto('audit.events')
    .values({
      actor_user_id: entry.actor,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      detail: JSON.stringify(entry.detail ?? {}),
    })
    .execute();
}
