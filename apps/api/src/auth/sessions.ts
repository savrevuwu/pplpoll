import type { Database, Role } from '@pplpoll/db';
import type { Kysely, Transaction } from 'kysely';
import { randomToken, sha256 } from '../core/crypto.js';

export const SESSION_COOKIE = 'pp_sid';
export const SESSION_TTL_MS = 30 * 24 * 3600_000;

export interface SessionUser {
  sessionId: string;
  userId: string;
  role: Role;
  csrfToken: string;
}

export async function createSession(
  trx: Transaction<Database>,
  userId: string,
  now: Date,
): Promise<{ token: string; csrfToken: string }> {
  const token = randomToken();
  const csrfToken = randomToken();
  await trx
    .insertInto('sessions')
    .values({
      token_hash: sha256(token),
      csrf_token: csrfToken,
      user_id: userId,
      created_at: now,
      last_seen_at: now,
      expires_at: new Date(now.getTime() + SESSION_TTL_MS),
    })
    .execute();
  return { token, csrfToken };
}

/**
 * Resolves a session cookie. Touching a session never reactivates an account:
 * deactivation revokes every session, and only an interactive sign-in reactivates.
 */
export async function resolveSession(
  db: Kysely<Database>,
  token: string,
  now: Date,
): Promise<SessionUser | null> {
  const row = await db
    .selectFrom('sessions as s')
    .innerJoin('users as u', 'u.id', 's.user_id')
    .select(['s.id', 's.user_id', 's.csrf_token', 'u.role', 'u.state'])
    .where('s.token_hash', '=', sha256(token))
    .where('s.revoked_at', 'is', null)
    .where('s.expires_at', '>', now)
    .executeTakeFirst();
  if (!row || (row.state !== 'active' && row.state !== 'frozen')) return null;
  await db
    .updateTable('sessions')
    .set({ last_seen_at: now, expires_at: new Date(now.getTime() + SESSION_TTL_MS) })
    .where('id', '=', row.id)
    .execute();
  return { sessionId: row.id, userId: row.user_id, role: row.role, csrfToken: row.csrf_token };
}

export async function revokeAllSessions(
  trx: Transaction<Database>,
  userId: string,
  now: Date,
): Promise<void> {
  await trx
    .updateTable('sessions')
    .set({ revoked_at: now })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();
}
