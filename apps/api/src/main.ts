import { createDb } from '@pplpoll/db';
import { Crypto, loadSecrets } from './core/crypto.js';
import { createLogger } from './logger.js';
import { MatchEvents } from './modules/matches/events.js';
import { buildServer } from './server.js';
import { finishExpiredMatches } from './modules/matches/service.js';
import type { AppDeps } from './core/deps.js';

const logger = createLogger();
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const db = createDb(url);
const deps: AppDeps = {
  db,
  logger,
  crypto: new Crypto(loadSecrets()),
  clock: () => new Date(),
  secureCookies: process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test',
  authRateLimit: { max: 10, timeWindowMs: 15 * 60_000 },
  answerRateLimit: { max: 60, timeWindowMs: 60_000 },
  events: new MatchEvents(),
};
const app = await buildServer(deps);
const port = Number(process.env.API_PORT ?? 3000);

await app.listen({ port, host: '0.0.0.0' });

// Ends matches when their clock runs out so live players get results without having to act.
const ticker = setInterval(() => {
  finishExpiredMatches(deps, new Date()).catch((err: unknown) =>
    logger.error({ err }, 'match ticker failed'),
  );
}, 1000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    clearInterval(ticker);
    void app.close().then(() => db.destroy());
  });
}
