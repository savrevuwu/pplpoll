import { createDb } from '@pplpoll/db';
import { Crypto, loadSecrets } from './core/crypto.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';

const logger = createLogger();
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const db = createDb(url);
const app = await buildServer({
  db,
  logger,
  crypto: new Crypto(loadSecrets()),
  clock: () => new Date(),
  secureCookies: process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test',
  authRateLimit: { max: 10, timeWindowMs: 15 * 60_000 },
  answerRateLimit: { max: 60, timeWindowMs: 60_000 },
});
const port = Number(process.env.API_PORT ?? 3000);

await app.listen({ port, host: '0.0.0.0' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => db.destroy());
  });
}
