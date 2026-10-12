import { createDb } from '@pplpoll/db';
import {
  Crypto,
  createLogger,
  dispatchOutbox,
  loadSecrets,
  publishDaily,
  computeSnapshots,
  runFinalDeletions,
  sendDeactivationWarnings,
  type EmailTransport,
} from '@pplpoll/api';
import { PgBoss } from 'pg-boss';

/**
 * Background job runner (ADR-004). Each job is safe to run twice: the work itself is idempotent
 * and row-locked, so overlapping runs or retries never double-send or double-delete.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const logger = createLogger();
const db = createDb(url);
const crypto = new Crypto(loadSecrets());

// Email provider not chosen yet (docs/decisions.md). This transport only logs the kind of email.
const transport: EmailTransport = {
  async send(message) {
    logger.info({ kind: message.kind }, 'email sent (log transport)');
  },
};

const boss = new PgBoss(url);
boss.on('error', (err: Error) => logger.error({ err }, 'pg-boss error'));
await boss.start();

const every = '* * * * *'; // every minute

await boss.createQueue('account.lifecycle');
await boss.schedule('account.lifecycle', every);
await boss.work('account.lifecycle', async () => {
  const now = new Date();
  const warned = await sendDeactivationWarnings({ db, crypto }, now);
  const deleted = await runFinalDeletions({ db, crypto }, now);
  if (warned || deleted) logger.info({ warned, deleted }, 'account lifecycle sweep');
});

await boss.createQueue('email.dispatch');
await boss.schedule('email.dispatch', every);
await boss.work('email.dispatch', async () => {
  const sent = await dispatchOutbox(db, crypto, transport, new Date());
  if (sent) logger.info({ sent }, 'email outbox dispatched');
});

// Daily Poll publication at 12:00 AM America/New_York (spec §2.4). Checked every minute so a
// restart or delay catches up; repeated runs are no-ops once today's poll is published.
await boss.createQueue('daily.publish');
await boss.schedule('daily.publish', every);
await boss.work('daily.publish', async () => {
  const r = await publishDaily({ db }, new Date());
  if (r.status !== 'already_published') logger.info({ status: r.status }, 'daily poll publication');
});

// 24-hour result snapshots (spec §4): one per poll per ET day, shortly after midnight publication.
await boss.createQueue('snapshots.compute');
await boss.schedule('snapshots.compute', '*/10 * * * *');
await boss.work('snapshots.compute', async () => {
  const made = await computeSnapshots({ db }, new Date());
  if (made) logger.info({ made }, 'result snapshots computed');
});

logger.info('worker started');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void boss.stop().then(() => db.destroy());
  });
}
