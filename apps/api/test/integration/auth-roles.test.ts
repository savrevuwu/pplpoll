// Spec §14, §19: server-side authorization, role escalation prevention, CSRF, sessions.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  as,
  createHarness,
  createOwner,
  login,
  makeInvite,
  signUp,
  type Harness,
  type Session,
} from '../support/harness.js';

let h: Harness;
let owner: Session;
let member: Session;
let admin: Session;

beforeAll(async () => {
  h = await createHarness();
  const o = await createOwner(h);
  owner = await login(h, o.email, o.password);
  const inv = await makeInvite(h, owner, 10);
  member = await signUp(h, inv.code);
  admin = await signUp(h, inv.code);
  const r = await h.app.inject({
    method: 'PUT',
    url: `/staff/users/${admin.userId}/role`,
    headers: as(owner),
    payload: { role: 'admin' },
  });
  expect(r.statusCode).toBe(200);
});
afterAll(() => h.close());

const setRole = (who: Session, target: string, role: string) =>
  h.app.inject({
    method: 'PUT',
    url: `/staff/users/${target}/role`,
    headers: as(who),
    payload: { role },
  });

describe('authorization', () => {
  it('requires sign-in for member routes', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/me' })).statusCode).toBe(401);
  });

  it('members and admins cannot manage invites (Owner only)', async () => {
    for (const who of [member, admin]) {
      const r = await h.app.inject({
        method: 'POST',
        url: '/staff/invites',
        headers: as(who),
        payload: { maxUses: 1 },
      });
      expect(r.statusCode).toBe(403);
      expect(
        (await h.app.inject({ method: 'GET', url: '/staff/invites', headers: as(who) })).statusCode,
      ).toBe(403);
    }
  });

  it('only the Owner promotes or demotes', async () => {
    expect((await setRole(member, member.userId, 'admin')).statusCode).toBe(403);
    expect((await setRole(admin, member.userId, 'moderator')).statusCode).toBe(403);
    expect((await setRole(owner, member.userId, 'moderator')).statusCode).toBe(200);
    expect((await setRole(owner, member.userId, 'member')).statusCode).toBe(200);
  });

  it('nobody can grant or take away the Owner role, or change their own role', async () => {
    expect((await setRole(owner, member.userId, 'owner')).statusCode).toBe(403);
    expect((await setRole(owner, owner.userId, 'admin')).statusCode).toBe(409);
    expect((await setRole(owner, member.userId, 'superuser')).statusCode).toBe(400);
  });

  it('a role change takes effect on the next request (role is read from the database)', async () => {
    await setRole(owner, member.userId, 'admin');
    // Admin still cannot manage invites, but the new role is what the server checks.
    const me = await h.app.inject({ method: 'GET', url: '/me', headers: as(member) });
    expect(me.json().role).toBe('admin');
    await setRole(owner, member.userId, 'member');
  });

  it('role changes are audited with before/after', async () => {
    const rows = await h.db
      .selectFrom('audit.events')
      .select(['action', 'actor_user_id', 'detail'])
      .where('action', '=', 'staff.role_change')
      .where('target_id', '=', admin.userId)
      .execute();
    expect(rows[0]).toMatchObject({
      actor_user_id: owner.userId,
      detail: { before: 'member', after: 'admin' },
    });
  });
});

describe('sessions and CSRF', () => {
  it('rejects state-changing requests without the CSRF token', async () => {
    const r = await h.app.inject({
      method: 'PATCH',
      url: '/me/profile',
      headers: { cookie: member.cookie },
      payload: { displayName: 'Hi' },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('CSRF_FAILED');
  });

  it('logout revokes the session', async () => {
    const s = await login(
      h,
      (await signUp(h, (await makeInvite(h, owner)).code)).email,
      'a-good-password',
    );
    expect(
      (await h.app.inject({ method: 'POST', url: '/auth/logout', headers: as(s) })).statusCode,
    ).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/me', headers: as(s) })).statusCode).toBe(
      401,
    );
  });

  it('wrong password and unknown email give the same answer', async () => {
    const a = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'owner@example.com', password: 'wrong-password' },
    });
    const b = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'ghost@example.com', password: 'wrong-password' },
    });
    expect(a.statusCode).toBe(401);
    expect(a.body).toBe(b.body);
  });

  it('session cookie is HttpOnly and SameSite=Lax', async () => {
    const r = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'owner@example.com', password: 'owner-password-1' },
    });
    const c = r.cookies.find((x) => x.name === 'pp_sid')!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe('Lax');
  });
});
