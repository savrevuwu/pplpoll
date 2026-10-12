import { randomInt } from 'node:crypto';
import type { Database } from '@pplpoll/db';
import type { Transaction } from 'kysely';
import { audit } from '../../core/audit.js';
import type { AppDeps } from '../../core/deps.js';
import { AppError, errors } from '../../core/errors.js';

// No 0/O/1/I/L to avoid copy mistakes when codes are shared in Discord DMs.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateInviteCode(): string {
  const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8).join('')}`;
}

/** Codes are compared case-insensitively, ignoring spaces and dashes. */
export function normalizeInviteCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '');
}

export const inviteInvalid = () =>
  new AppError(400, 'INVITE_INVALID', 'That invite code is not valid');

export async function createInvite(
  deps: AppDeps,
  actorId: string,
  input: { maxUses: number; expiresAt: Date | null; label: string | null },
): Promise<{ id: string; code: string }> {
  const now = deps.clock();
  if (input.expiresAt && input.expiresAt <= now) {
    throw new AppError(400, 'VALIDATION_FAILED', 'Expiry must be in the future');
  }
  const code = generateInviteCode();
  return deps.db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto('invite_codes')
      .values({
        code_lookup: deps.crypto.lookup('invite', normalizeInviteCode(code)),
        code_enc: deps.crypto.encrypt(code),
        label: input.label,
        max_uses: input.maxUses,
        expires_at: input.expiresAt,
        created_by: actorId,
        created_at: now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await audit(trx, {
      actor: actorId,
      action: 'invite.create',
      targetType: 'invite',
      targetId: row.id,
      detail: { maxUses: input.maxUses, expiresAt: input.expiresAt?.toISOString() ?? null },
    });
    return { id: row.id, code };
  });
}

export async function listInvites(deps: AppDeps) {
  const rows = await deps.db
    .selectFrom('invite_codes')
    .selectAll()
    .orderBy('created_at', 'desc')
    .execute();
  const now = deps.clock();
  return rows.map((r) => ({
    id: r.id,
    code: deps.crypto.decrypt(r.code_enc),
    label: r.label,
    maxUses: r.max_uses,
    usesCount: r.uses_count,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    createdAt: r.created_at,
    usable: isUsable(r, now),
  }));
}

export async function listRedemptions(deps: AppDeps, inviteId: string) {
  return deps.db
    .selectFrom('invite_redemptions as r')
    .innerJoin('profiles as p', 'p.user_id', 'r.user_id')
    .select(['p.username', 'r.redeemed_at as redeemedAt'])
    .where('r.invite_id', '=', inviteId)
    .orderBy('r.redeemed_at')
    .execute();
}

export async function revokeInvite(deps: AppDeps, actorId: string, inviteId: string) {
  await deps.db.transaction().execute(async (trx) => {
    const res = await trx
      .updateTable('invite_codes')
      .set({ revoked_at: deps.clock() })
      .where('id', '=', inviteId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (res.numUpdatedRows === 0n) {
      const exists = await trx
        .selectFrom('invite_codes')
        .select('id')
        .where('id', '=', inviteId)
        .executeTakeFirst();
      if (!exists) throw errors.notFound();
      return;
    }
    await audit(trx, {
      actor: actorId,
      action: 'invite.revoke',
      targetType: 'invite',
      targetId: inviteId,
    });
  });
}

function isUsable(
  r: { revoked_at: Date | null; expires_at: Date | null; uses_count: number; max_uses: number },
  now: Date,
): boolean {
  return !r.revoked_at && (!r.expires_at || r.expires_at > now) && r.uses_count < r.max_uses;
}

/** Read-only check; does not consume a use. */
export async function checkInvite(deps: AppDeps, code: string): Promise<boolean> {
  const row = await deps.db
    .selectFrom('invite_codes')
    .select(['revoked_at', 'expires_at', 'uses_count', 'max_uses'])
    .where('code_lookup', '=', deps.crypto.lookup('invite', normalizeInviteCode(code)))
    .executeTakeFirst();
  return row !== undefined && isUsable(row, deps.clock());
}

/**
 * Locks the invite row for the rest of the registration transaction. The use is counted only
 * if the whole registration commits, so failed sign-ups never consume a code.
 */
export async function lockInviteForRedemption(
  trx: Transaction<Database>,
  deps: AppDeps,
  code: string,
  now: Date,
): Promise<string> {
  const row = await trx
    .selectFrom('invite_codes')
    .select(['id', 'revoked_at', 'expires_at', 'uses_count', 'max_uses'])
    .where('code_lookup', '=', deps.crypto.lookup('invite', normalizeInviteCode(code)))
    .forUpdate()
    .executeTakeFirst();
  if (!row || !isUsable(row, now)) throw inviteInvalid();
  return row.id;
}

export async function recordRedemption(
  trx: Transaction<Database>,
  inviteId: string,
  userId: string,
  now: Date,
): Promise<void> {
  await trx
    .updateTable('invite_codes')
    .set((eb) => ({ uses_count: eb('uses_count', '+', 1) }))
    .where('id', '=', inviteId)
    .execute();
  await trx
    .insertInto('invite_redemptions')
    .values({ invite_id: inviteId, user_id: userId, redeemed_at: now })
    .execute();
}
