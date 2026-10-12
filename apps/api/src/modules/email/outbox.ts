import type { Database } from '@pplpoll/db';
import type { Kysely, Transaction } from 'kysely';
import type { Crypto } from '../../core/crypto.js';

export type EmailMessage =
  | { kind: 'verify_email'; to: string; token: string }
  | { kind: 'deactivation_warning'; to: string; deletionDate: string };

/**
 * Queues an email in the caller's transaction. Payloads (address, tokens) are encrypted at rest
 * and wiped once sent. `dedupeKey` makes enqueueing idempotent.
 */
export async function enqueueEmail(
  trx: Transaction<Database>,
  crypto: Crypto,
  dedupeKey: string,
  message: EmailMessage,
  now: Date,
): Promise<void> {
  await trx
    .insertInto('email_outbox')
    .values({
      dedupe_key: dedupeKey,
      kind: message.kind,
      payload_enc: crypto.encrypt(JSON.stringify(message)),
      created_at: now,
    })
    .onConflict((oc) => oc.column('dedupe_key').doNothing())
    .execute();
}

export interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
}

/**
 * Sends queued emails. Rows are claimed with SKIP LOCKED so several workers can run safely.
 * An email provider is not chosen yet (docs/decisions.md); production must supply a real transport.
 */
export async function dispatchOutbox(
  db: Kysely<Database>,
  crypto: Crypto,
  transport: EmailTransport,
  now: Date,
  batchSize = 50,
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom('email_outbox')
      .select(['id', 'payload_enc'])
      .where('sent_at', 'is', null)
      .orderBy('created_at')
      .limit(batchSize)
      .forUpdate()
      .skipLocked()
      .execute();
    for (const row of rows) {
      await transport.send(JSON.parse(crypto.decrypt(row.payload_enc)) as EmailMessage);
      await trx
        .updateTable('email_outbox')
        .set({ sent_at: now, payload_enc: '' })
        .where('id', '=', row.id)
        .execute();
    }
    return rows.length;
  });
}
