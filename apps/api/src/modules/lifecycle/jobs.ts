import { addEtDays, etDate } from '@pplpoll/domain';
import { audit } from '../../core/audit.js';
import type { AppDeps } from '../../core/deps.js';
import { enqueueEmail } from '../email/outbox.js';

type JobDeps = Pick<AppDeps, 'db' | 'crypto'>;

const pending = (deps: JobDeps) =>
  deps.db
    .selectFrom('account_lifecycle as l')
    .innerJoin('users as u', 'u.id', 'l.user_id')
    .where('u.state', '=', 'deactivated')
    .where('l.reactivated_at', 'is', null)
    .where('l.deleted_at', 'is', null);

/**
 * Sends the warning email 30 days before the deletion deadline (spec §10, §23.7).
 * Idempotent: keyed by user + lifecycle generation, and rows are locked while processed.
 */
export async function sendDeactivationWarnings(deps: JobDeps, now: Date): Promise<number> {
  const due = await pending(deps)
    .select(['l.user_id'])
    .where('l.warning_due_at', '<=', now)
    .where('l.warning_sent_at', 'is', null)
    .where('l.deletion_due_at', '>', now)
    .execute();
  let sent = 0;
  for (const { user_id } of due) {
    await deps.db.transaction().execute(async (trx) => {
      const lc = await trx
        .selectFrom('account_lifecycle as l')
        .innerJoin('users as u', 'u.id', 'l.user_id')
        .innerJoin('credentials as c', 'c.user_id', 'l.user_id')
        .select([
          'l.generation',
          'l.deletion_due_at',
          'l.warning_sent_at',
          'l.reactivated_at',
          'u.state',
          'c.email_enc',
        ])
        .where('l.user_id', '=', user_id)
        .forUpdate(['l'])
        .executeTakeFirst();
      if (!lc || lc.state !== 'deactivated' || lc.warning_sent_at || lc.reactivated_at) return;
      // The deletion happens at the start of this date; the email names the last day to sign in.
      const lastDay = addEtDays(etDate(lc.deletion_due_at), -1);
      await enqueueEmail(
        trx,
        deps.crypto,
        `deactivation-warning:${user_id}:${lc.generation}`,
        {
          kind: 'deactivation_warning',
          to: deps.crypto.decrypt(lc.email_enc),
          deletionDate: lastDay,
        },
        now,
      );
      await trx
        .updateTable('account_lifecycle')
        .set({ warning_sent_at: now })
        .where('user_id', '=', user_id)
        .execute();
      await audit(trx, {
        actor: null,
        action: 'account.deactivation_warning',
        targetType: 'user',
        targetId: user_id,
        detail: { generation: lc.generation },
      });
      sent++;
    });
  }
  return sent;
}

/**
 * Final deletion once the one-year period ends without reactivation.
 * Removes account-associated personal data; keeps the permanent username reservation and the
 * participation-uniqueness record (subject to legal review L1/L2). Audit history stays.
 */
export async function runFinalDeletions(deps: JobDeps, now: Date): Promise<number> {
  const due = await pending(deps)
    .select(['l.user_id'])
    .where('l.deletion_due_at', '<=', now)
    .execute();
  let deleted = 0;
  for (const { user_id } of due) {
    await deps.db.transaction().execute(async (trx) => {
      const lc = await trx
        .selectFrom('account_lifecycle as l')
        .innerJoin('users as u', 'u.id', 'l.user_id')
        .select([
          'l.generation',
          'l.deletion_due_at',
          'l.reactivated_at',
          'l.deleted_at',
          'u.state',
        ])
        .where('l.user_id', '=', user_id)
        .forUpdate()
        .executeTakeFirst();
      if (
        !lc ||
        lc.state !== 'deactivated' ||
        lc.reactivated_at ||
        lc.deleted_at ||
        lc.deletion_due_at > now
      )
        return;
      await trx.deleteFrom('sessions').where('user_id', '=', user_id).execute();
      await trx.deleteFrom('email_verification_tokens').where('user_id', '=', user_id).execute();
      await trx.deleteFrom('credentials').where('user_id', '=', user_id).execute();
      await trx.deleteFrom('profiles').where('user_id', '=', user_id).execute();
      await trx.updateTable('users').set({ state: 'deleted' }).where('id', '=', user_id).execute();
      await trx
        .updateTable('account_lifecycle')
        .set({ deleted_at: now })
        .where('user_id', '=', user_id)
        .execute();
      await audit(trx, {
        actor: null,
        action: 'account.final_deletion',
        targetType: 'user',
        targetId: user_id,
        detail: { generation: lc.generation },
      });
      deleted++;
    });
  }
  return deleted;
}
