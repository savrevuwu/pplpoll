import { PgBoss } from 'pg-boss';

/**
 * Background job runner (ADR-004). M0 only boots pg-boss; jobs such as
 * `daily.publish` (00:00 ET) and `snapshot.compute` are added in their milestones,
 * each with an idempotency (singleton) key.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const boss = new PgBoss(url);
boss.on('error', (err: Error) => {
  process.stderr.write(`pg-boss error: ${err.name}\n`);
});
await boss.start();
process.stdout.write('worker started\n');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void boss.stop();
  });
}
