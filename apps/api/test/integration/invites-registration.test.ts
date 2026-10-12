// Spec §10, AT-26: invite-only registration; atomic redemption; username/email rules.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  as,
  createHarness,
  createOwner,
  login,
  makeInvite,
  newUser,
  outbox,
  signUp,
  type Harness,
  type Session,
} from '../support/harness.js';

let h: Harness;
let owner: Session;

beforeAll(async () => {
  h = await createHarness();
  const o = await createOwner(h);
  owner = await login(h, o.email, o.password);
});
afterAll(() => h.close());

const register = (payload: Record<string, unknown>) =>
  h.app.inject({ method: 'POST', url: '/auth/register', payload });

const usesOf = async (id: string) =>
  (
    await h.db
      .selectFrom('invite_codes')
      .select('uses_count')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  ).uses_count;

describe('invite codes', () => {
  it('can be checked without consuming them, ignoring case and dashes', async () => {
    const inv = await makeInvite(h, owner);
    const loose = inv.code.toLowerCase().replace(/-/g, ' ');
    const res = await h.app.inject({
      method: 'POST',
      url: '/auth/invite/check',
      payload: { code: loose },
    });
    expect(res.json()).toEqual({ valid: true });
    expect(await usesOf(inv.id)).toBe(0);
  });

  it('a single-use code admits exactly one of 15 concurrent registrations', async () => {
    const inv = await makeInvite(h, owner, 1);
    const results = await Promise.all(
      Array.from({ length: 15 }, () => register({ inviteCode: inv.code, ...newUser('race') })),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 400)).toHaveLength(14);
    expect(results.find((r) => r.statusCode === 400)!.json().error.code).toBe('INVITE_INVALID');
    expect(await usesOf(inv.id)).toBe(1);
    const redemptions = await h.db
      .selectFrom('invite_redemptions')
      .where('invite_id', '=', inv.id)
      .select('id')
      .execute();
    expect(redemptions).toHaveLength(1);
  });

  it('a 3-use code admits exactly three of 10 concurrent registrations', async () => {
    const inv = await makeInvite(h, owner, 3);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => register({ inviteCode: inv.code, ...newUser('multi') })),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(3);
    expect(await usesOf(inv.id)).toBe(3);
  });

  it('is not consumed when registration fails', async () => {
    const inv = await makeInvite(h, owner, 1);
    const taken = await signUp(h, (await makeInvite(h, owner)).code);
    const res = await register({
      inviteCode: inv.code,
      ...newUser(),
      username: taken.username.toUpperCase(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('USERNAME_TAKEN');
    expect(await usesOf(inv.id)).toBe(0);
    expect((await register({ inviteCode: inv.code, ...newUser() })).statusCode).toBe(201);
  });

  it('rejects expired and revoked codes', async () => {
    const expiring = await makeInvite(h, owner, 5, {
      expiresAt: new Date(h.clock.now.getTime() + 60_000).toISOString(),
    });
    h.clock.advance(60_000);
    expect((await register({ inviteCode: expiring.code, ...newUser() })).json().error.code).toBe(
      'INVITE_INVALID',
    );

    const revoked = await makeInvite(h, owner, 5);
    const r = await h.app.inject({
      method: 'POST',
      url: `/staff/invites/${revoked.id}/revoke`,
      headers: as(owner),
    });
    expect(r.statusCode).toBe(200);
    expect((await register({ inviteCode: revoked.code, ...newUser() })).json().error.code).toBe(
      'INVITE_INVALID',
    );
  });

  it('Owner can list codes (to copy) and see redemptions', async () => {
    const inv = await makeInvite(h, owner, 2, { label: 'Discord batch' });
    const u = await signUp(h, inv.code);
    const list = (
      await h.app.inject({ method: 'GET', url: '/staff/invites', headers: as(owner) })
    ).json();
    const row = list.invites.find((i: { id: string }) => i.id === inv.id);
    expect(row).toMatchObject({
      code: inv.code,
      label: 'Discord batch',
      maxUses: 2,
      usesCount: 1,
      usable: true,
    });
    const red = (
      await h.app.inject({
        method: 'GET',
        url: `/staff/invites/${inv.id}/redemptions`,
        headers: as(owner),
      })
    ).json();
    expect(red.redemptions.map((r: { username: string }) => r.username)).toEqual([u.username]);
  });

  it('stores codes encrypted, not in plaintext', async () => {
    const inv = await makeInvite(h, owner);
    const row = await h.db
      .selectFrom('invite_codes')
      .selectAll()
      .where('id', '=', inv.id)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain(inv.code);
  });
});

describe('registration rules', () => {
  it('rejects invalid usernames, display names, emails and short passwords', async () => {
    const inv = await makeInvite(h, owner, 50);
    for (const bad of [
      { username: 'ab' },
      { username: 'has_underscore' },
      { username: 'x'.repeat(21) },
      { displayName: '   ' },
      { displayName: 'Bad!' },
      { email: 'not-an-email' },
      { password: 'short' },
    ]) {
      const res = await register({ inviteCode: inv.code, ...newUser(), ...bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
    }
    expect(await usesOf(inv.id)).toBe(0);
  });

  it('rejects unknown fields such as a self-assigned role (mass assignment)', async () => {
    const inv = await makeInvite(h, owner);
    const res = await register({ inviteCode: inv.code, ...newUser(), role: 'admin' });
    expect(res.statusCode).toBe(400);
  });

  it('does not echo submitted values in validation errors', async () => {
    const inv = await makeInvite(h, owner);
    const res = await register({ inviteCode: inv.code, ...newUser(), password: 'secretXY' });
    expect(res.body).not.toContain('secretXY');
  });

  it('usernames are unique case-insensitively, also under concurrency', async () => {
    const inv = await makeInvite(h, owner, 10);
    const results = await Promise.all(
      ['SameName', 'samename', 'SAMENAME', 'sAmEnAmE'].map((username) =>
        register({ inviteCode: inv.code, ...newUser(), username }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(3);
  });

  it('one account per email (case-insensitive)', async () => {
    const inv = await makeInvite(h, owner, 10);
    const u = newUser();
    expect((await register({ inviteCode: inv.code, ...u })).statusCode).toBe(201);
    const dup = await register({
      inviteCode: inv.code,
      ...newUser(),
      email: u.email.toUpperCase(),
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('EMAIL_IN_USE');
  });

  it('requires email verification before sign-in, then allows it', async () => {
    const inv = await makeInvite(h, owner);
    const u = newUser();
    await register({ inviteCode: inv.code, ...u });
    const before = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: u.email, password: u.password },
    });
    expect(before.json().error.code).toBe('EMAIL_NOT_VERIFIED');
    const mail = (await outbox(h)).find((m) => m.kind === 'verify_email' && m.to === u.email);
    expect(mail).toBeDefined();
    const ok = await h.app.inject({
      method: 'POST',
      url: '/auth/verify-email',
      payload: { token: (mail as { token: string }).token },
    });
    expect(ok.statusCode).toBe(200);
    const again = await h.app.inject({
      method: 'POST',
      url: '/auth/verify-email',
      payload: { token: (mail as { token: string }).token },
    });
    expect(again.json().error.code).toBe('TOKEN_INVALID');
    expect((await login(h, u.email, u.password)).userId).toBeTruthy();
  });

  it('stores email encrypted and password hashed', async () => {
    const u = await signUp(h, (await makeInvite(h, owner)).code);
    const cred = await h.db
      .selectFrom('credentials')
      .selectAll()
      .where('user_id', '=', u.userId)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(cred)).not.toContain(u.email);
    expect(cred.password_hash).toMatch(/^\$argon2id\$/);
  });
});
