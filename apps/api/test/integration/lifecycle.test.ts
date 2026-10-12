// Spec §10, §13, §23.7, AT-23, AT-31: one-year deactivation, 30-day warning, reactivation, final deletion.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runFinalDeletions, sendDeactivationWarnings } from '../../src/index.js';
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
let ownerCreds: { email: string; password: string };
beforeAll(async () => {
  h = await createHarness();
  ownerCreds = await createOwner(h);
});
// Tests move the clock by months, so sign the Owner in fresh each time (sessions last 30 days).
const ownerSession = () => login(h, ownerCreds.email, ownerCreds.password);
afterAll(() => h.close());

const DAY = 24 * 3600_000;
const deactivate = (s: Session, password = 'a-good-password') =>
  h.app.inject({
    method: 'POST',
    url: '/account/deactivate',
    headers: as(s),
    payload: { password },
  });
const lifecycle = (userId: string) =>
  h.db
    .selectFrom('account_lifecycle')
    .selectAll()
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
const jobs = () => ({ deps: h.deps, now: h.clock.fn() });
const warnings = async () => sendDeactivationWarnings(jobs().deps, jobs().now);
const deletions = async () => runFinalDeletions(jobs().deps, jobs().now);

async function freshUser() {
  return signUp(h, (await makeInvite(h, await ownerSession())).code);
}

describe('deactivation', () => {
  it('requires the password and hides the profile immediately', async () => {
    const u = await freshUser();
    const viewer = await freshUser();
    expect((await deactivate(u, 'wrong-password')).statusCode).toBe(401);
    const res = await deactivate(u);
    expect(res.statusCode).toBe(200);
    expect(res.json().lastReactivationDate).toBe('2027-10-12');
    const view = await h.app.inject({
      method: 'GET',
      url: `/users/${u.username}`,
      headers: as(viewer),
    });
    expect(view.statusCode).toBe(404);
    // All sessions are revoked: passive visits/token refresh can't reactivate.
    expect(
      (await h.app.inject({ method: 'GET', url: '/auth/session', headers: as(u) })).statusCode,
    ).toBe(401);
    expect(
      (
        await h.db
          .selectFrom('users')
          .select('state')
          .where('id', '=', u.userId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('deactivated');
  });

  it('interactive sign-in before the deadline reactivates and cancels deletion', async () => {
    const u = await freshUser();
    await deactivate(u);
    h.clock.advance(200 * DAY);
    const s = await login(h, u.email, u.password);
    const me = await h.app.inject({ method: 'GET', url: '/me', headers: as(s) });
    expect(me.statusCode).toBe(200);
    expect((await lifecycle(u.userId)).reactivated_at).not.toBeNull();
    h.clock.advance(400 * DAY);
    await deletions();
    expect(
      (
        await h.db
          .selectFrom('users')
          .select('state')
          .where('id', '=', u.userId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('active');
  });

  it('login reports reactivation', async () => {
    const u = await freshUser();
    await deactivate(u);
    const r = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: u.email, password: u.password },
    });
    expect(r.json().reactivated).toBe(true);
  });

  it('sends the warning exactly 30 days before the deadline, once, naming the date', async () => {
    h.clock.set('2026-10-12T18:00:00Z'); // 2:00 PM EDT
    const u = await freshUser();
    await deactivate(u);
    const lc = await lifecycle(u.userId);
    expect(lc.deletion_due_at.toISOString()).toBe('2027-10-13T04:00:00.000Z');
    expect(lc.warning_due_at.toISOString()).toBe('2027-09-13T04:00:00.000Z');
    expect(lc.deletion_due_at.getTime() - lc.warning_due_at.getTime()).toBe(30 * DAY);

    h.clock.set(new Date(lc.warning_due_at.getTime() - 1));
    await warnings();
    expect(
      (await outbox(h)).filter((m) => m.kind === 'deactivation_warning' && m.to === u.email),
    ).toHaveLength(0);

    h.clock.set(lc.warning_due_at);
    await warnings();
    await warnings(); // idempotent
    const mails = (await outbox(h)).filter(
      (m) => m.kind === 'deactivation_warning' && m.to === u.email,
    );
    expect(mails).toEqual([
      { kind: 'deactivation_warning', to: u.email, deletionDate: '2027-10-12' },
    ]);
  });

  it('deletes at the deadline: personal data removed, username stays reserved, email reusable', async () => {
    h.clock.set('2026-10-12T18:00:00Z');
    const u = await freshUser();
    await deactivate(u);
    const lc = await lifecycle(u.userId);

    h.clock.set(new Date(lc.deletion_due_at.getTime() - 1));
    expect(await deletions()).toBe(0);
    h.clock.set(lc.deletion_due_at);
    await deletions();
    await deletions(); // idempotent

    expect(
      (
        await h.db
          .selectFrom('users')
          .select('state')
          .where('id', '=', u.userId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('deleted');
    expect(
      await h.db
        .selectFrom('credentials')
        .where('user_id', '=', u.userId)
        .select('user_id')
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(
      await h.db
        .selectFrom('profiles')
        .where('user_id', '=', u.userId)
        .select('user_id')
        .executeTakeFirst(),
    ).toBeUndefined();

    // Sign-in after the deadline fails.
    const r = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: u.email, password: u.password },
    });
    expect(r.statusCode).toBe(401);

    // Re-registration: same email allowed, old username still reserved, nothing transfers.
    const inv = await makeInvite(h, await ownerSession(), 5);
    const same = await h.app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { inviteCode: inv.code, ...newUser(), email: u.email, username: u.username },
    });
    expect(same.json().error.code).toBe('USERNAME_TAKEN');
    const again = await h.app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { inviteCode: inv.code, ...newUser(), email: u.email },
    });
    expect(again.statusCode).toBe(201);
    expect(again.json().userId).not.toBe(u.userId);

    // Participation identity is the same person -> survey uniqueness survives (spec §1, §10).
    const ids = await h.db
      .selectFrom('user_participation_identity')
      .select('participation_identity_id')
      .where('user_id', 'in', [u.userId, again.json().userId])
      .execute();
    expect(new Set(ids.map((i) => i.participation_identity_id)).size).toBe(1);
  });

  it('a later deactivation starts a completely new one-year period', async () => {
    h.clock.set('2026-10-12T18:00:00Z');
    const u = await freshUser();
    await deactivate(u);
    h.clock.set('2027-09-20T12:00:00Z');
    await warnings();
    const s = await login(h, u.email, u.password);
    h.clock.set('2027-10-01T12:00:00Z');
    await deactivate(s);
    const lc = await lifecycle(u.userId);
    expect(lc.generation).toBe(2);
    expect(lc.warning_sent_at).toBeNull();
    expect(lc.deletion_due_at.toISOString()).toBe('2028-10-02T04:00:00.000Z');
    h.clock.set('2027-10-13T12:00:00Z'); // the old deadline passes harmlessly
    await deletions();
    expect(
      (
        await h.db
          .selectFrom('users')
          .select('state')
          .where('id', '=', u.userId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('deactivated');
  });

  it('the Owner account cannot be deactivated', async () => {
    const r = await h.app.inject({
      method: 'POST',
      url: '/account/deactivate',
      headers: as(await ownerSession()),
      payload: { password: 'owner-password-1' },
    });
    expect(r.statusCode).toBe(409);
  });

  it('every lifecycle step is audited', async () => {
    const actions = (
      await h.db.selectFrom('audit.events').select('action').distinct().execute()
    ).map((r) => r.action);
    for (const a of [
      'account.register',
      'account.deactivate',
      'account.reactivate',
      'account.deactivation_warning',
      'account.final_deletion',
    ]) {
      expect(actions).toContain(a);
    }
  });
});
