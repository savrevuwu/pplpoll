// Spec §2, §23.6, AT-01..03, AT-29 (queue part): Daily Poll queue, calendar, midnight publish, emergencies.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { publishDaily } from '../../src/index.js';
import {
  as,
  createHarness,
  createOwner,
  login,
  makeInvite,
  setRole,
  signUp,
  type Harness,
  type Session,
} from '../support/harness.js';

let h: Harness;
let owner: Session;
let admin: Session;
let mod: Session;
let viewer: Session;
let ownerCreds: { email: string; password: string };

// Fresh database per test: the Daily Poll is global state.
beforeEach(async () => {
  if (h) await h.close();
  h = await createHarness();
  h.clock.set('2026-10-12T16:00:00Z'); // Oct 12, 12:00 PM EDT
  ownerCreds = await createOwner(h);
  owner = await login(h, ownerCreds.email, ownerCreds.password);
  const inv = await makeInvite(h, owner, 20);
  admin = await signUp(h, inv.code);
  mod = await signUp(h, inv.code);
  viewer = await signUp(h, inv.code);
  await setRole(h, owner, admin.userId, 'admin');
  await setRole(h, owner, mod.userId, 'moderator');
});
afterAll(() => h.close());

const seed = async (
  text = `Name a thing in category ${randomUUID().slice(0, 8)}`,
  visibility = 'public',
  by = owner,
) => {
  const r = await h.app.inject({
    method: 'POST',
    url: '/staff/polls',
    headers: as(by),
    payload: { text, visibility },
  });
  if (r.statusCode !== 201) throw new Error(r.body);
  h.clock.advance(1000); // keep approval order deterministic
  return r.json().pollId as string;
};
const publish = (iso?: string) => {
  if (iso) h.clock.set(iso);
  return publishDaily(h.deps, h.clock.fn());
};
const pollRow = (id: string) =>
  h.db.selectFrom('polls').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const daily = async (s: Session = viewer) =>
  (await h.app.inject({ method: 'GET', url: '/daily/poll', headers: as(s) })).json();
const schedule = (s: Session, date: string, pollId: string) =>
  h.app.inject({
    method: 'PUT',
    url: `/staff/daily/calendar/${date}`,
    headers: as(s),
    payload: { pollId },
  });

describe('midnight publication', () => {
  it('publishes the oldest queued poll at 12:00 AM ET; nothing is live before that', async () => {
    const first = await seed();
    await seed();
    expect((await daily()).available).toBe(false);
    const r = await publish('2026-10-13T04:00:00Z'); // 12:00 AM EDT Oct 13
    expect(r).toEqual({ status: 'published', pollId: first });
    expect(await pollRow(first)).toMatchObject({
      status: 'live_daily',
      debut_et_date: '2026-10-13',
      response_count: 0,
    });
    const d = await daily();
    expect(d).toMatchObject({ etDate: '2026-10-13', available: true, poll: { id: first } });
  });

  it('is idempotent: 10 concurrent runs publish exactly one poll', async () => {
    await seed();
    await seed();
    h.clock.set('2026-10-13T04:00:05Z');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => publishDaily(h.deps, h.clock.fn())),
    );
    expect(results.filter((r) => r.status === 'published')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'already_published')).toHaveLength(9);
    expect(await h.db.selectFrom('daily_features').select('id').execute()).toHaveLength(1);
  });

  it('the previous Daily Poll becomes a regular survey; a poll is never featured twice', async () => {
    const a = await seed();
    const b = await seed();
    await publish('2026-10-13T04:00:00Z');
    await publish('2026-10-14T04:00:00Z');
    expect((await pollRow(a)).status).toBe('survey');
    expect(await pollRow(b)).toMatchObject({ status: 'live_daily', debut_et_date: '2026-10-14' });
    const featured = await h.db.selectFrom('daily_features').select('poll_id').execute();
    expect(new Set(featured.map((f) => f.poll_id)).size).toBe(featured.length);
  });

  it('uses the America/New_York date, including across DST', async () => {
    await seed();
    // Nov 1 is fall-back day; 04:30Z is 12:30 AM EDT (clocks go back at 2 AM).
    const r = await publish('2026-11-01T04:30:00Z');
    expect(r.status).toBe('published');
    const f = await h.db.selectFrom('daily_features').select('et_date').executeTakeFirstOrThrow();
    expect(f.et_date).toBe('2026-11-01');
  });

  it('empty queue: no recycling, controlled unavailable state, staff alerted once', async () => {
    const a = await seed();
    await publish('2026-10-13T04:00:00Z');
    const r1 = await publish('2026-10-14T04:00:00Z');
    const r2 = await publish('2026-10-14T04:01:00Z');
    expect(r1).toEqual({ status: 'unavailable' });
    expect(r2).toEqual({ status: 'unavailable' });
    expect((await pollRow(a)).status).toBe('survey'); // not recycled
    expect(await daily()).toMatchObject({ available: false });
    const exceptions = await h.db
      .selectFrom('daily_poll_exceptions')
      .selectAll()
      .where('kind', '=', 'queue_empty')
      .execute();
    expect(exceptions).toHaveLength(1);
    const alerts = await h.db
      .selectFrom('notifications')
      .select('user_id')
      .where('kind', '=', 'staff_daily_queue_empty')
      .execute();
    expect(alerts.map((x) => x.user_id).sort()).toEqual([admin.userId, owner.userId].sort());
  });

  it('creator gets one go-live notification', async () => {
    const u = await signUp(h, (await makeInvite(h, owner)).code);
    await setRole(h, owner, u.userId, 'admin');
    const pollId = await seed(undefined, 'public', u);
    await publish('2026-10-13T04:00:00Z');
    await publish('2026-10-13T04:05:00Z');
    const n = await h.db
      .selectFrom('notifications')
      .select(['kind', 'payload'])
      .where('user_id', '=', u.userId)
      .where('kind', '=', 'poll_live')
      .execute();
    expect(n).toHaveLength(1);
    expect(n[0]!.payload).toEqual({ pollId, link: '/daily' });
  });
});

describe('staff calendar', () => {
  it('Admin/Owner schedule upcoming days; the scheduled poll wins over queue order', async () => {
    await seed();
    const chosen = await seed();
    expect((await schedule(admin, '2026-10-13', chosen)).statusCode).toBe(200);
    expect(await publish('2026-10-13T04:00:00Z')).toEqual({ status: 'published', pollId: chosen });
  });

  it('moderators and members cannot use the calendar', async () => {
    const p = await seed();
    expect((await schedule(mod, '2026-10-13', p)).statusCode).toBe(403);
    expect((await schedule(viewer, '2026-10-13', p)).statusCode).toBe(403);
    expect(
      (await h.app.inject({ method: 'GET', url: '/staff/daily', headers: as(mod) })).statusCode,
    ).toBe(403);
  });

  it('today and past days cannot be scheduled; one poll cannot take two days', async () => {
    const p = await seed();
    expect((await schedule(admin, '2026-10-12', p)).json().error.code).toBe('DATE_NOT_IN_FUTURE');
    expect((await schedule(admin, '2026-10-15', p)).statusCode).toBe(200);
    expect((await schedule(admin, '2026-10-16', p)).json().error.code).toBe('ALREADY_SCHEDULED');
  });

  it('auto-selection skips polls reserved for a later day, and unscheduled days still get a poll', async () => {
    const reserved = await seed();
    const other = await seed();
    await schedule(admin, '2026-10-20', reserved);
    expect(await publish('2026-10-13T04:00:00Z')).toEqual({ status: 'published', pollId: other });
    expect((await pollRow(reserved)).status).toBe('queued');
  });

  it('a poll that has debuted can no longer be scheduled or edited', async () => {
    const p = await seed();
    await publish('2026-10-13T04:00:00Z');
    expect((await schedule(admin, '2026-10-20', p)).json().error.code).toBe('POLL_NOT_QUEUED');
    const edit = await h.app.inject({
      method: 'PATCH',
      url: `/staff/polls/${p}`,
      headers: as(mod),
      payload: { text: 'Name a totally different thing now' },
    });
    expect(edit.json().error.code).toBe('POLL_NOT_EDITABLE');
  });
});

describe('emergency replacement', () => {
  const replace = (s: Session, payload: Record<string, unknown> = { reason: 'Broke the rules' }) =>
    h.app.inject({
      method: 'POST',
      url: '/staff/daily/emergency-replace',
      headers: as(s),
      payload,
    });

  it('removes the original (kept for records) and features a fresh zero-response poll', async () => {
    const original = await seed();
    const fresh = await seed();
    await publish('2026-10-13T04:00:00Z');
    h.clock.set('2026-10-13T15:00:00Z');
    const r = await replace(admin);
    expect(r.json()).toEqual({ status: 'published', pollId: fresh });
    expect(await pollRow(original)).toMatchObject({
      status: 'removed',
      removed_reason: 'Broke the rules',
      debut_et_date: '2026-10-13',
    });
    expect(await pollRow(fresh)).toMatchObject({
      status: 'live_daily',
      debut_et_date: '2026-10-13',
    });
    const features = await h.db
      .selectFrom('daily_features')
      .selectAll()
      .orderBy('started_at')
      .execute();
    expect(features.map((f) => [f.kind, f.active])).toEqual([
      ['primary', false],
      ['emergency_replacement', true],
    ]);
    expect(features[1]!.replaces_feature_id).toBe(features[0]!.id);
    expect((await daily()).poll.id).toBe(fresh);
    // The midnight job does not undo or double-publish.
    expect((await publish('2026-10-13T16:00:00Z')).status).toBe('already_published');
  });

  it('never uses a previously answered poll; empty queue gives a controlled unavailable state', async () => {
    const yesterday = await seed();
    await publish('2026-10-13T04:00:00Z');
    await seed();
    await publish('2026-10-14T04:00:00Z');
    h.clock.set('2026-10-14T15:00:00Z');
    const bad = await replace(admin, { reason: 'x', replacementPollId: yesterday });
    expect(bad.json().error.code).toBe('POLL_NOT_QUEUED');
    const r = await replace(admin, { reason: 'Broke the rules' });
    expect(r.json()).toEqual({ status: 'unavailable' });
    expect(await daily()).toMatchObject({ available: false });
    expect((await publish('2026-10-14T16:00:00Z')).status).toBe('unavailable');
    const kinds = (await h.db.selectFrom('daily_poll_exceptions').select('kind').execute())
      .map((e) => e.kind)
      .sort();
    expect(kinds).toEqual(['emergency_no_replacement', 'emergency_removed']);
  });

  it('only Admin/Owner can do it', async () => {
    await seed();
    await publish('2026-10-13T04:00:00Z');
    expect((await replace(mod)).statusCode).toBe(403);
  });
});

describe('attribution on the Daily Poll', () => {
  async function liveCreatorPoll(visibility: 'public' | 'anonymous') {
    const u = await signUp(h, (await makeInvite(h, owner)).code);
    await setRole(h, owner, u.userId, 'admin');
    await seed(undefined, visibility, u);
    await publish('2026-10-13T04:00:00Z');
    return u;
  }

  it('public shows the username; the global hide switch hides it and switching off restores it', async () => {
    const u = await liveCreatorPoll('public');
    expect((await daily()).poll.creator).toBe(u.username);
    const toggle = (hide: boolean) =>
      h.app.inject({
        method: 'PUT',
        url: '/me/settings/poll-attribution',
        headers: as(u),
        payload: { hideNameOnAllPolls: hide },
      });
    await toggle(true);
    expect((await daily()).poll.creator).toBeNull();
    await toggle(false);
    expect((await daily()).poll.creator).toBe(u.username);
  });

  it('anonymous polls never show a name', async () => {
    await liveCreatorPoll('anonymous');
    expect((await daily()).poll.creator).toBeNull();
  });

  it('the poll stays live without attribution when the creator deactivates', async () => {
    const u = await liveCreatorPoll('public');
    await setRole(h, owner, u.userId, 'member');
    await h.app.inject({
      method: 'POST',
      url: '/account/deactivate',
      headers: as(u),
      payload: { password: 'a-good-password' },
    });
    const d = await daily();
    expect(d.available).toBe(true);
    expect(d.poll.creator).toBeNull();
  });
});
