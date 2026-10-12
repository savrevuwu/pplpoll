import { createDb } from '@pplpoll/db';
import type { Kysely } from 'kysely';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';

const logger = createLogger();
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const db = createDb(url) as unknown as Kysely<unknown>;
const app = buildServer({ db, logger });
const port = Number(process.env.API_PORT ?? 3000);

await app.listen({ port, host: '0.0.0.0' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => db.destroy());
  });
}
