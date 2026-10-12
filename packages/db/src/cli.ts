import { createDb } from './client.js';
import { migrateDownOne, migrateToLatest } from './migrator.js';
import type { Kysely } from 'kysely';

const direction = process.argv[2];
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
if (direction !== 'up' && direction !== 'down') throw new Error('usage: cli.ts up|down');

const db = createDb(url) as unknown as Kysely<unknown>;
try {
  const result = direction === 'up' ? await migrateToLatest(db) : await migrateDownOne(db);
  for (const r of result.results ?? []) {
    process.stdout.write(`${r.direction} ${r.migrationName}: ${r.status}\n`);
  }
} finally {
  await db.destroy();
}
