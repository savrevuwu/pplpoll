import { createDb } from '@pplpoll/db';
import {
  Crypto,
  createLogger,
  dispatchOutbox,
  loadSecrets,
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

logger.info('worker started');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void boss.stop().then(() => db.destroy());
  });
}
