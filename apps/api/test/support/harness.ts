import { randomBytes } from 'node:crypto';
import { createDb, migrateToLatest, type Database } from '@pplpoll/db';
import { sql } from 'kysely';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Kysely } from 'kysely';
import { Crypto } from '../../src/core/crypto.js';
import type { AppDeps } from '../../src/core/deps.js';
import { createLogger } from '../../src/logger.js';
import { MatchEvents } from '../../src/modules/matches/events.js';
import type { EmailMessage } from '../../src/modules/email/outbox.js';
import { insertAccount } from '../../src/modules/accounts/service.js';
import { buildServer } from '../../src/server.js';

export const TEST_URL = process.env.TEST_DATABASE_URL ?? '';
if (!TEST_URL) throw new Error('TEST_DATABASE_URL is required for integration tests');

/** Controllable clock so time-based rules can be tested exactly. */
/** Wipes the test database completely (rollback paths are tested separately on an empty DB). */
async function resetTestDatabase(db: Kysely<Database>) {
  await sql`DROP SCHEMA IF EXISTS audit CASCADE`.execute(db);
  await sql`DROP SCHEMA public CASCADE`.execute(db);
  await sql`CREATE SCHEMA public`.execute(db);
}

export class TestClock {
  constructor(public now = new Date('2026-10-12T16:00:00Z')) {}
  readonly fn = () => new Date(this.now);
  advance(ms: number) {
    this.now = new Date(this.now.getTime() + ms);
  }
  set(iso: string | Date) {
    this.now = new Date(iso);
  }
}

export interface Harness {
  app: FastifyInstance;
  deps: AppDeps;
  db: Kysely<Database>;
  clock: TestClock;
  close(): Promise<void>;
}

export async function createHarness(
  opts: { rateLimitMax?: number; answerRateLimitMax?: number; logger?: AppDeps['logger'] } = {},
): Promise<Harness> {
  const db = createDb(TEST_URL);
  await resetTestDatabase(db);
  await migrateToLatest(db as unknown as Kysely<unknown>);
  const clock = new TestClock();
  const deps: AppDeps = {
    db,
    logger: opts.logger ?? createLogger({ level: 'silent' }),
    crypto: new Crypto({ encryptionKey: randomBytes(32), hmacKey: randomBytes(32) }),
    clock: clock.fn,
    secureCookies: false,
    authRateLimit: { max: opts.rateLimitMax ?? 10_000, timeWindowMs: 60_000 },
    answerRateLimit: { max: opts.answerRateLimitMax ?? 10_000, timeWindowMs: 60_000 },
    events: new MatchEvents(),
  };
  const app = await buildServer(deps);
  return {
    app,
    deps,
    db,
    clock,
    close: async () => {
      await app.close();
      await db.destroy();
    },
  };
}

export async function createOwner(h: Harness) {
  const creds = { email: 'owner@example.com', password: 'owner-password-1', username: 'TheOwner' };
  const userId = await h.db
    .transaction()
    .execute((trx) =>
      insertAccount(
        trx,
        h.deps,
        { ...creds, displayName: null, role: 'owner', verified: true },
        h.clock.fn(),
      ),
    );
  return { ...creds, userId };
}

export interface Session {
  cookie: string;
  csrf: string;
  userId: string;
}

export async function login(h: Harness, email: string, password: string): Promise<Session> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode} ${res.body}`);
  return { cookie: sessionCookie(res), csrf: res.json().csrfToken, userId: res.json().userId };
}

export function sessionCookie(res: LightMyRequestResponse): string {
  const c = res.cookies.find((x) => x.name === 'pp_sid');
  if (!c) throw new Error('no session cookie');
  return `pp_sid=${c.value}`;
}

export function as(s: Session) {
  return { cookie: s.cookie, 'x-csrf-token': s.csrf };
}

export async function makeInvite(
  h: Harness,
  owner: Session,
  maxUses = 1,
  extra: Record<string, unknown> = {},
) {
  const res = await h.app.inject({
    method: 'POST',
    url: '/staff/invites',
    headers: as(owner),
    payload: { maxUses, ...extra },
  });
  if (res.statusCode !== 201) throw new Error(`invite failed ${res.statusCode} ${res.body}`);
  return res.json() as { id: string; code: string };
}

export async function outbox(h: Harness): Promise<EmailMessage[]> {
  const rows = await h.db
    .selectFrom('email_outbox')
    .select('payload_enc')
    .where('sent_at', 'is', null)
    .orderBy('created_at')
    .execute();
  return rows.map((r) => JSON.parse(h.deps.crypto.decrypt(r.payload_enc)) as EmailMessage);
}

let seq = 0;
export function newUser(prefix = 'user') {
  seq++;
  return {
    email: `${prefix}${seq}@example.com`,
    password: 'a-good-password',
    username: `${prefix}${seq}`,
  };
}

/** Registers with an invite, verifies the email, and signs in. */
export async function signUp(
  h: Harness,
  inviteCode: string,
  user = newUser(),
): Promise<Session & typeof user> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { inviteCode, ...user },
  });
  if (res.statusCode !== 201) throw new Error(`register failed ${res.statusCode} ${res.body}`);
  const mail = (await outbox(h))
    .filter((m) => m.kind === 'verify_email' && m.to === user.email)
    .at(-1);
  if (!mail || mail.kind !== 'verify_email') throw new Error('no verification email');
  const v = await h.app.inject({
    method: 'POST',
    url: '/auth/verify-email',
    payload: { token: mail.token },
  });
  if (v.statusCode !== 200) throw new Error(`verify failed ${v.body}`);
  return { ...user, ...(await login(h, user.email, user.password)) };
}

/** Test-only: give a user Poll Points directly (daily awards arrive in M3). */
export async function grantPp(h: Harness, userId: string, amount: number) {
  await h.db
    .insertInto('pp_accounts')
    .values({ user_id: userId, balance: amount })
    .onConflict((oc) =>
      oc
        .column('user_id')
        .doUpdateSet((eb) => ({ balance: eb('pp_accounts.balance', '+', amount) })),
    )
    .execute();
}

export async function setRole(h: Harness, owner: Session, userId: string, role: string) {
  const r = await h.app.inject({
    method: 'PUT',
    url: `/staff/users/${userId}/role`,
    headers: as(owner),
    payload: { role },
  });
  if (r.statusCode !== 200) throw new Error(`role change failed ${r.body}`);
}

export async function balanceOf(h: Harness, userId: string) {
  return (
    (
      await h.db
        .selectFrom('pp_accounts')
        .select('balance')
        .where('user_id', '=', userId)
        .executeTakeFirst()
    )?.balance ?? 0
  );
}
