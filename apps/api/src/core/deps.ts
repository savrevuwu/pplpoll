import type { Database } from '@pplpoll/db';
import type { Kysely } from 'kysely';
import type { FastifyBaseLogger } from 'fastify';
import type { Crypto } from './crypto.js';

export type Clock = () => Date;

export interface AppDeps {
  db: Kysely<Database>;
  logger: FastifyBaseLogger;
  crypto: Crypto;
  clock: Clock;
  /** Cookies are `Secure` in every environment except local development and tests. */
  secureCookies: boolean;
  /** Per-IP limits for brute-forceable auth routes. */
  authRateLimit: { max: number; timeWindowMs: number };
  /** Per-person limit on survey answer submissions. */
  answerRateLimit: { max: number; timeWindowMs: number };
}
