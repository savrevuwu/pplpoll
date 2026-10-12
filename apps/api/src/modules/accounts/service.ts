import type { Database } from '@pplpoll/db';
import { cooldownEndsAt, deactivationSchedule, normalizeEmail, usernameKey } from '@pplpoll/domain';
import type { Transaction } from 'kysely';
import { audit } from '../../core/audit.js';
import { randomToken, sha256 } from '../../core/crypto.js';
import type { AppDeps } from '../../core/deps.js';
import { AppError, isUniqueViolation } from '../../core/errors.js';
import { createSession, revokeAllSessions } from '../../auth/sessions.js';
import { enqueueEmail } from '../email/outbox.js';
import { lockInviteForRedemption, recordRedemption } from '../invites/service.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from './passwords.js';

const VERIFY_TTL_MS = 24 * 3600_000;

const usernameTaken = () => new AppError(409, 'USERNAME_TAKEN', 'That username is not available');
const emailInUse = () => new AppError(409, 'EMAIL_IN_USE', 'An account already uses that email');
const invalidCredentials = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');

export interface RegisterInput {
  inviteCode: string;
  email: string;
  password: string;
  username: string;
  displayName: string | null;
}

/** Shared by registration and Owner bootstrap: creates user, reserved username, profile, credentials. */
export async function insertAccount(
  trx: Transaction<Database>,
  deps: AppDeps,
  input: Omit<RegisterInput, 'inviteCode'> & { role?: 'owner'; verified?: boolean },
  now: Date,
): Promise<string> {
  const email = normalizeEmail(input.email);
  const passwordHash = await hashPassword(input.password);
  const user = await trx
    .insertInto('users')
    .values({ role: input.role ?? 'member', created_at: now })
    .returning('id')
    .executeTakeFirstOrThrow();

  try {
    await trx
      .insertInto('username_reservations')
      .values({ username_key: usernameKey(input.username), user_id: user.id, reserved_at: now })
      .execute();
  } catch (err) {
    if (isUniqueViolation(err)) throw usernameTaken();
    throw err;
  }

  await trx
    .insertInto('profiles')
    .values({
      user_id: user.id,
      username: input.username,
      display_name: input.displayName,
      display_name_changed_at: null,
      created_at: now,
    })
    .execute();

  try {
    await trx
      .insertInto('credentials')
      .values({
        user_id: user.id,
        email_lookup: deps.crypto.lookup('email', email),
        email_enc: deps.crypto.encrypt(email),
        password_hash: passwordHash,
        email_verified_at: input.verified ? now : null,
        created_at: now,
      })
      .execute();
  } catch (err) {
    if (isUniqueViolation(err)) throw emailInUse();
    throw err;
  }

  // Participation identity survives account deletion so survey answers can't be repeated (§1, §10).
  const identityHmac = deps.crypto.lookup('participation', email);
  await trx
    .insertInto('participation_identities')
    .values({ identity_hmac: identityHmac, created_at: now })
    .onConflict((oc) => oc.column('identity_hmac').doNothing())
    .execute();
  const identity = await trx
    .selectFrom('participation_identities')
    .select('id')
    .where('identity_hmac', '=', identityHmac)
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('user_participation_identity')
    .values({ user_id: user.id, participation_identity_id: identity.id })
    .execute();

  return user.id;
}

async function issueVerification(
  trx: Transaction<Database>,
  deps: AppDeps,
  userId: string,
  email: string,
  now: Date,
): Promise<void> {
  const token = randomToken();
  await trx
    .insertInto('email_verification_tokens')
    .values({
      token_hash: sha256(token),
      user_id: userId,
      expires_at: new Date(now.getTime() + VERIFY_TTL_MS),
      used_at: null,
    })
    .execute();
  await enqueueEmail(
    trx,
    deps.crypto,
    `verify:${sha256(token)}`,
    { kind: 'verify_email', to: email, token },
    now,
  );
}

export async function register(deps: AppDeps, input: RegisterInput): Promise<{ userId: string }> {
  const now = deps.clock();
  return deps.db.transaction().execute(async (trx) => {
    const inviteId = await lockInviteForRedemption(trx, deps, input.inviteCode, now);
    const userId = await insertAccount(trx, deps, input, now);
    await recordRedemption(trx, inviteId, userId, now);
    await issueVerification(trx, deps, userId, normalizeEmail(input.email), now);
    await audit(trx, {
      actor: userId,
      action: 'account.register',
      targetType: 'user',
      targetId: userId,
      detail: { inviteId },
    });
    return { userId };
  });
}

export async function verifyEmail(deps: AppDeps, token: string): Promise<void> {
  const now = deps.clock();
  await deps.db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('email_verification_tokens')
      .select(['user_id', 'expires_at', 'used_at'])
      .where('token_hash', '=', sha256(token))
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.used_at || row.expires_at <= now) {
      throw new AppError(400, 'TOKEN_INVALID', 'That link is invalid or has expired');
    }
    await trx
      .updateTable('email_verification_tokens')
      .set({ used_at: now })
      .where('token_hash', '=', sha256(token))
      .execute();
    await trx
      .updateTable('credentials')
      .set({ email_verified_at: now })
      .where('user_id', '=', row.user_id)
      .where('email_verified_at', 'is', null)
      .execute();
    await audit(trx, {
      actor: row.user_id,
      action: 'account.verify_email',
      targetType: 'user',
      targetId: row.user_id,
    });
  });
}

/** Always succeeds from the caller's view so it can't be used to discover accounts. */
export async function resendVerification(deps: AppDeps, emailInput: string): Promise<void> {
  const now = deps.clock();
  const email = normalizeEmail(emailInput);
  await deps.db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('credentials as c')
      .innerJoin('users as u', 'u.id', 'c.user_id')
      .select(['c.user_id'])
      .where('c.email_lookup', '=', deps.crypto.lookup('email', email))
      .where('c.email_verified_at', 'is', null)
      .where('u.state', '=', 'active')
      .executeTakeFirst();
    if (row) await issueVerification(trx, deps, row.user_id, email, now);
  });
}

export interface LoginResult {
  token: string;
  csrfToken: string;
  userId: string;
  reactivated: boolean;
}

/**
 * Interactive sign-in. This is the ONLY path that reactivates a deactivated account (§10, §23.7).
 */
export async function login(
  deps: AppDeps,
  emailInput: string,
  password: string,
): Promise<LoginResult> {
  const now = deps.clock();
  const email = normalizeEmail(emailInput);
  const cred = await deps.db
    .selectFrom('credentials')
    .select(['user_id', 'password_hash', 'email_verified_at'])
    .where('email_lookup', '=', deps.crypto.lookup('email', email))
    .executeTakeFirst();
  if (!cred) {
    await burnPasswordCheck(password);
    throw invalidCredentials();
  }
  if (!(await verifyPassword(cred.password_hash, password))) throw invalidCredentials();
  if (!cred.email_verified_at) {
    throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Please verify your email first');
  }

  return deps.db.transaction().execute(async (trx) => {
    const user = await trx
      .selectFrom('users')
      .select(['state'])
      .where('id', '=', cred.user_id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    let reactivated = false;
    if (user.state === 'banned' || user.state === 'deleted') {
      throw new AppError(403, 'ACCOUNT_RESTRICTED', 'This account cannot sign in');
    }
    if (user.state === 'deactivated') {
      const lc = await trx
        .selectFrom('account_lifecycle')
        .select(['deletion_due_at', 'generation'])
        .where('user_id', '=', cred.user_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (lc.deletion_due_at <= now) throw invalidCredentials();
      await trx
        .updateTable('users')
        .set({ state: 'active' })
        .where('id', '=', cred.user_id)
        .execute();
      await trx
        .updateTable('account_lifecycle')
        .set({ reactivated_at: now })
        .where('user_id', '=', cred.user_id)
        .execute();
      await audit(trx, {
        actor: cred.user_id,
        action: 'account.reactivate',
        targetType: 'user',
        targetId: cred.user_id,
        detail: { generation: lc.generation },
      });
      reactivated = true;
    }
    const session = await createSession(trx, cred.user_id, now);
    return { ...session, userId: cred.user_id, reactivated };
  });
}

export async function logout(deps: AppDeps, sessionId: string): Promise<void> {
  await deps.db
    .updateTable('sessions')
    .set({ revoked_at: deps.clock() })
    .where('id', '=', sessionId)
    .execute();
}

/** Voluntary closure = deactivation. Each call starts a completely new one-year period. */
export async function deactivate(deps: AppDeps, userId: string, password: string) {
  const now = deps.clock();
  const cred = await deps.db
    .selectFrom('credentials')
    .select('password_hash')
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
  if (!(await verifyPassword(cred.password_hash, password))) throw invalidCredentials();
  if (
    (
      await deps.db
        .selectFrom('users')
        .select('role')
        .where('id', '=', userId)
        .executeTakeFirstOrThrow()
    ).role === 'owner'
  ) {
    throw new AppError(409, 'OWNER_CANNOT_DEACTIVATE', 'The Owner account cannot be deactivated');
  }

  const schedule = deactivationSchedule(now);
  await deps.db.transaction().execute(async (trx) => {
    const user = await trx
      .selectFrom('users')
      .select('state')
      .where('id', '=', userId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (user.state !== 'active')
      throw new AppError(409, 'INVALID_STATE', 'Account cannot be deactivated now');
    const prev = await trx
      .selectFrom('account_lifecycle')
      .select('generation')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    const generation = (prev?.generation ?? 0) + 1;
    const values = {
      generation,
      deactivated_at: now,
      deletion_due_at: schedule.deletionDueAt,
      warning_due_at: schedule.warningDueAt,
      warning_sent_at: null,
      reactivated_at: null,
      deleted_at: null,
    };
    await trx
      .insertInto('account_lifecycle')
      .values({ user_id: userId, ...values })
      .onConflict((oc) => oc.column('user_id').doUpdateSet(values))
      .execute();
    await trx.updateTable('users').set({ state: 'deactivated' }).where('id', '=', userId).execute();
    await revokeAllSessions(trx, userId, now);
    await audit(trx, {
      actor: userId,
      action: 'account.deactivate',
      targetType: 'user',
      targetId: userId,
      detail: { generation, deletionDueAt: schedule.deletionDueAt.toISOString() },
    });
  });
  return schedule;
}

export async function updateDisplayName(deps: AppDeps, userId: string, displayName: string | null) {
  const now = deps.clock();
  await deps.db.transaction().execute(async (trx) => {
    const profile = await trx
      .selectFrom('profiles')
      .select(['display_name', 'display_name_changed_at'])
      .where('user_id', '=', userId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (profile.display_name === displayName) return;
    if (profile.display_name_changed_at) {
      const retryAt = cooldownEndsAt(profile.display_name_changed_at);
      if (now < retryAt) {
        throw new AppError(
          429,
          'DISPLAY_NAME_COOLDOWN',
          'You can change your display name again later',
          {
            retryAt: retryAt.toISOString(),
          },
        );
      }
    }
    await trx
      .updateTable('profiles')
      .set({ display_name: displayName, display_name_changed_at: now })
      .where('user_id', '=', userId)
      .execute();
    await audit(trx, {
      actor: userId,
      action: 'profile.display_name',
      targetType: 'user',
      targetId: userId,
    });
  });
}

export async function getMe(deps: AppDeps, userId: string) {
  return deps.db
    .selectFrom('users as u')
    .innerJoin('profiles as p', 'p.user_id', 'u.id')
    .select([
      'u.id',
      'p.username',
      'p.display_name as displayName',
      'u.role',
      'u.created_at as joinedAt',
      'p.display_name_changed_at as displayNameChangedAt',
    ])
    .where('u.id', '=', userId)
    .executeTakeFirstOrThrow();
}

/** Account-associated profile content is hidden unless the account is active (§13). */
export async function getPublicProfile(deps: AppDeps, username: string) {
  return deps.db
    .selectFrom('profiles as p')
    .innerJoin('users as u', 'u.id', 'p.user_id')
    .select([
      'u.id as userId',
      'p.username',
      'p.display_name as displayName',
      'u.created_at as joinedAt',
    ])
    .where((eb) => eb(eb.fn('lower', ['p.username']), '=', usernameKey(username)))
    .where('u.state', '=', 'active')
    .executeTakeFirst();
}
