// Spec §1, §3, §4, §17, §18, §23.6 — AT-01, AT-04..07, AT-28 (answering), AT-29.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { publishDaily, runFinalDeletions } from '../../src/index.js';
import {
  as,
  balanceOf,
  createHarness,
  createOwner,
  login,
  makeInvite,
  newUser,
  setRole,
  signUp,
  type Harness,
  type Session,
} from '../support/harness.js';

let h: Harness;
let owner: Session;
let admin: Session;
let ownerCreds: { email: string; password: string };

beforeEach(async () => {
  if (h) await h.close();
  h = await createHarness();
  h.clock.set('2026-10-12T16:00:00Z'); // Oct 12, 12:00 PM EDT
  ownerCreds = await createOwner(h);
  owner = await login(h, ownerCreds.email, ownerCreds.password);
  admin = await signUp(h, (await makeInvite(h, owner)).code);
  await setRole(h, owner, admin.userId, 'admin');
});
afterAll(() => h.close());

/** Test shortcut: n polls that already had their Daily Poll day (debut dates in the past). */
async function surveyPolls(n: number) {
  const rows = Array.from({ length: n }, (_, i) => ({
    text: `Existing survey question number ${i} ${randomUUID().slice(0, 6)}`,
    exact_key: `existing survey ${randomUUID()}`,
    creator_visibility: 'anonymous' as const,
    status: 'survey' as const,
    debut_et_date: `2025-01-${String((i % 28) + 1).padStart(2, '0')}`,
    approved_at: new Date('2024-12-01T00:00:00Z'),
  }));
  return (await h.db.insertInto('polls').values(rows).returning('id').execute()).map((r) => r.id);
}
async function queuedPoll() {
  const r = await h.app.inject({
    method: 'POST',
    url: '/staff/polls',
    headers: as(owner),
    payload: { text: `Name a thing for today ${randomUUID().slice(0, 8)}` },
  });
  return r.json().pollId as string;
}
/** World with today's Daily Poll live and `pool` regular survey polls. */
async function world(pool = 12) {
  const ids = await surveyPolls(pool);
  await queuedPoll();
  await publishDaily(h.deps, h.clock.fn());
  return ids;
}
const member = async () =>
  signUp(h, (await makeInvite(h, await login(h, ownerCreds.email, ownerCreds.password))).code);
const daily = async (s: Session) => {
  const r = await h.app.inject({ method: 'GET', url: '/daily', headers: as(s) });
  if (r.statusCode !== 200) throw new Error(r.body);
  return r.json();
};
const answerDaily = (s: Session, pollId: string, text = 'Keys') =>
  h.app.inject({
    method: 'POST',
    url: '/daily/poll/response',
    headers: as(s),
    payload: { pollId, text },
  });
const answerSlot = (s: Session, slot: number, pollId: string, text = 'Keys') =>
  h.app.inject({
    method: 'POST',
    url: `/daily/assignments/${slot}/response`,
    headers: as(s),
    payload: { pollId, text },
  });

async function answerAllSlots(
  s: Session,
  d: { assignments: { slot: number; poll: { id: string } }[] },
) {
  const out = [];
  for (const a of d.assignments) out.push(await answerSlot(s, a.slot, a.poll.id));
  return out;
}

describe('daily survey page', () => {
  it('shows the Daily Poll plus 10 existing surveys, progress 0/11', async () => {
    await world();
    const u = await member();
    const d = await daily(u);
    expect(d.dailyPoll).toMatchObject({ available: true, answered: false });
    expect(d.assignments).toHaveLength(10);
    expect(new Set(d.assignments.map((a: { poll: { id: string } }) => a.poll.id)).size).toBe(10);
    expect(d.progress).toEqual({ completed: 0, target: 11, possible: 11 });
    expect(d.ppAwarded).toBe(false);
    // Same assignments on a second visit.
    expect((await daily(u)).assignments).toEqual(d.assignments);
  });

  it('an approved poll cannot take any response before its Daily Poll debut (database rule)', async () => {
    const q = await queuedPoll();
    const u = await member();
    const pi = await h.db
      .selectFrom('user_participation_identity')
      .select('participation_identity_id')
      .where('user_id', '=', u.userId)
      .executeTakeFirstOrThrow();
    await expect(
      h.db
        .insertInto('survey_responses')
        .values({
          poll_id: q,
          participation_identity_id: pi.participation_identity_id,
          user_id: u.userId,
          et_date: '2026-10-12',
          context: 'assignment',
          daily_feature_id: null,
          assignment_slot: 1,
          counts_for_progress: true,
          normalized_key: 'x',
          normalization_version: 1,
          answer_group_id: null,
          submitted_at: new Date(),
        })
        .execute(),
    ).rejects.toThrow(/not open for survey responses/);
  });

  it('pool smaller than 10: fewer surveys, and the day cannot earn PP (no invented credit)', async () => {
    await world(4);
    const u = await member();
    const d = await daily(u);
    expect(d.assignments).toHaveLength(4);
    expect(d.progress.possible).toBe(5);
    await answerDaily(u, d.dailyPoll.poll.id);
    await answerAllSlots(u, d);
    const after = await daily(u);
    expect(after.progress.completed).toBe(5);
    expect(after.ppAwarded).toBe(false);
    expect(await balanceOf(h, u.userId)).toBe(0);
  });
});

describe('answering', () => {
  it('shows "Thank you for your response" and never allows a second answer', async () => {
    await world();
    const u = await member();
    const d = await daily(u);
    const r = await answerDaily(u, d.dailyPoll.poll.id, '  My Keys! ');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      status: 'accepted',
      message: 'Thank you for your response',
      alreadyAnswered: false,
      progress: { completed: 1, target: 11 },
    });
    const again = await answerDaily(u, d.dailyPoll.poll.id, 'Wallet');
    expect(again.json()).toMatchObject({ alreadyAnswered: true, progress: { completed: 1 } });
    const count = await h.db
      .selectFrom('polls')
      .select('response_count')
      .where('id', '=', d.dailyPoll.poll.id)
      .executeTakeFirstOrThrow();
    expect(count.response_count).toBe(1);
  });

  it('concurrent duplicate submissions store exactly one answer', async () => {
    await world();
    const u = await member();
    const d = await daily(u);
    const a = d.assignments[0];
    const results = await Promise.all(
      Array.from({ length: 8 }, () => answerSlot(u, a.slot, a.poll.id)),
    );
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(results.filter((r) => !r.json().alreadyAnswered)).toHaveLength(1);
    const rows = await h.db
      .selectFrom('survey_responses')
      .select('id')
      .where('poll_id', '=', a.poll.id)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('rejects garbage without using up the answer; a real answer then works', async () => {
    await world();
    const u = await member();
    const d = await daily(u);
    const bad = await answerDaily(u, d.dailyPoll.poll.id, 'idk');
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('RESPONSE_REJECTED');
    expect((await answerDaily(u, d.dailyPoll.poll.id, 'Lip balm')).json().alreadyAnswered).toBe(
      false,
    );
  });

  it('keeps raw text encrypted and separate; stores a normalized key', async () => {
    await world();
    const u = await member();
    const d = await daily(u);
    await answerDaily(u, d.dailyPoll.poll.id, 'The Sunglasses!');
    const resp = await h.db
      .selectFrom('survey_responses')
      .selectAll()
      .where('user_id', '=', u.userId)
      .executeTakeFirstOrThrow();
    expect(resp.normalized_key).toBe('sunglasses');
    const raw = await h.db
      .selectFrom('survey_response_raw')
      .selectAll()
      .where('response_id', '=', resp.id)
      .executeTakeFirstOrThrow();
    expect(raw.raw_text_enc).not.toContain('Sunglasses');
    expect(h.deps.crypto.decrypt(raw.raw_text_enc)).toBe('The Sunglasses!');
  });

  it('a removed poll cannot be answered', async () => {
    await world();
    const u = await member();
    const d = await daily(u);
    const a = d.assignments[0];
    await h.db
      .updateTable('polls')
      .set({ status: 'removed' })
      .where('id', '=', a.poll.id)
      .execute();
    expect((await answerSlot(u, a.slot, a.poll.id)).json().error.code).toBe('POLL_UNAVAILABLE');
  });

  it('per-person rate limit on answers', async () => {
    await h.close();
    h = await createHarness({ answerRateLimitMax: 3 });
    ownerCreds = await createOwner(h);
    owner = await login(h, ownerCreds.email, ownerCreds.password);
    await world();
    const u = await member();
    const d = await daily(u);
    const statuses = [];
    for (const a of d.assignments.slice(0, 5))
      statuses.push((await answerSlot(u, a.slot, a.poll.id)).statusCode);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });
});

describe('daily Poll Point', () => {
  it('11 answers give exactly 1 PP on the 11th; 10 give none', async () => {
    await world();
    const u = await member();
    const d = await daily(u);
    const slots = await answerAllSlots(u, d);
    expect(slots.every((r) => r.json().ppAwarded === false)).toBe(true);
    expect(await balanceOf(h, u.userId)).toBe(0); // 10 answers -> 0 PP
    const last = await answerDaily(u, d.dailyPoll.poll.id);
    expect(last.json()).toMatchObject({ ppAwarded: true, progress: { completed: 11, target: 11 } });
    expect(await balanceOf(h, u.userId)).toBe(1);
    const awards = await h.db
      .selectFrom('pp_ledger')
      .select('et_date')
      .where('user_id', '=', u.userId)
      .where('kind', '=', 'daily_award')
      .execute();
    expect(awards).toEqual([{ et_date: '2026-10-12' }]);
    const streaks = (
      await h.app.inject({ method: 'GET', url: '/me/streaks', headers: as(u) })
    ).json();
    expect(streaks.answering).toMatchObject({ current: 1, longest: 1 });
    const n = await h.db
      .selectFrom('notifications')
      .select('kind')
      .where('user_id', '=', u.userId)
      .where('kind', '=', 'pp_awarded')
      .execute();
    expect(n).toHaveLength(1);
  });

  it('all 11 answers sent at once still award exactly 1 PP', async () => {
    await world();
    const u = await member();
    const d = await daily(u);
    const results = await Promise.all([
      answerDaily(u, d.dailyPoll.poll.id),
      ...d.assignments.map((a: { slot: number; poll: { id: string } }) =>
        answerSlot(u, a.slot, a.poll.id),
      ),
    ]);
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(results.filter((r) => r.json().ppAwarded)).toHaveLength(1);
    expect(await balanceOf(h, u.userId)).toBe(1);
  });

  it("midnight: yesterday's assignments cannot be answered after 12:00 AM ET", async () => {
    await world(25);
    const u = await member();
    const d = await daily(u);
    await answerSlot(u, 1, d.assignments[0].poll.id);
    h.clock.set('2026-10-13T04:00:00.001Z'); // 12:00 AM EDT Oct 13
    const late = await answerSlot(u, 2, d.assignments[1].poll.id);
    expect(late.json().error.code).toBe('DAY_ROLLED_OVER');
    const lateDaily = await answerDaily(u, d.dailyPoll.poll.id);
    expect(['DAY_ROLLED_OVER', 'DAILY_POLL_UNAVAILABLE']).toContain(lateDaily.json().error.code);
    // New day: fresh assignments, never including a poll already answered.
    const today = await daily(u);
    expect(today.etDate).toBe('2026-10-13');
    expect(today.assignments.map((a: { poll: { id: string } }) => a.poll.id)).not.toContain(
      d.assignments[0].poll.id,
    );
    expect(today.progress.completed).toBe(0);
  });

  it('answering streak: consecutive days add up; a missed day restarts it; longest is kept', async () => {
    await world(60);
    const u = await member();
    const completeDay = async () => {
      const d = await daily(u);
      await answerAllSlots(u, d);
      return (await answerDaily(u, d.dailyPoll.poll.id)).json().ppAwarded;
    };
    const nextDay = async (iso: string) => {
      h.clock.set(iso);
      await queuedPoll();
      await publishDaily(h.deps, h.clock.fn());
    };
    expect(await completeDay()).toBe(true);
    await nextDay('2026-10-13T16:00:00Z');
    expect(await completeDay()).toBe(true);
    let s = (
      await h.app.inject({
        method: 'GET',
        url: '/me/streaks',
        headers: as(await login(h, u.email, u.password)),
      })
    ).json();
    expect(s.answering).toMatchObject({ current: 2, longest: 2 });
    await nextDay('2026-10-15T16:00:00Z'); // skipped Oct 14
    const fresh = await login(h, u.email, u.password);
    s = (await h.app.inject({ method: 'GET', url: '/me/streaks', headers: as(fresh) })).json();
    expect(s.answering).toMatchObject({ current: 0, longest: 2 });
    expect(await completeDay()).toBe(true);
    s = (await h.app.inject({ method: 'GET', url: '/me/streaks', headers: as(fresh) })).json();
    expect(s.answering).toMatchObject({ current: 1, longest: 2 });
  });
});

describe('emergency replacement credit (spec §23.6)', () => {
  it("earlier Daily Poll credit is kept; the replacement is optional and can't give a second PP", async () => {
    await world();
    await queuedPoll(); // replacement candidate
    const early = await member();
    const late = await member();
    const d = await daily(early);
    await answerDaily(early, d.dailyPoll.poll.id);
    const rep = await h.app.inject({
      method: 'POST',
      url: '/staff/daily/emergency-replace',
      headers: as(await login(h, ownerCreds.email, ownerCreds.password)),
      payload: { reason: 'Rule break' },
    });
    expect(rep.json().status).toBe('published');
    const replacementId = rep.json().pollId;

    const e = await daily(early);
    expect(e.dailyPoll).toMatchObject({
      poll: { id: replacementId },
      answered: false,
      optional: true,
    });
    expect(e.progress.completed).toBe(1);
    const opt = await answerDaily(early, replacementId);
    expect(opt.json()).toMatchObject({ countsForProgress: false, progress: { completed: 1 } });
    await answerAllSlots(early, e);
    expect(await balanceOf(h, early.userId)).toBe(1);

    const l = await daily(late);
    expect(l.dailyPoll.optional).toBe(false);
    expect((await answerDaily(late, replacementId)).json()).toMatchObject({
      countsForProgress: true,
      progress: { completed: 1 },
    });
  });
});

describe('one answer per person for life (AT-06)', () => {
  it('a deleted-and-recreated account never gets polls it already answered', async () => {
    await world(13);
    const u = await member();
    const d = await daily(u);
    const answered = d.assignments.slice(0, 3);
    for (const a of answered) await answerSlot(u, a.slot, a.poll.id);
    await h.app.inject({
      method: 'POST',
      url: '/account/deactivate',
      headers: as(u),
      payload: { password: u.password },
    });
    h.clock.set('2027-10-20T16:00:00Z');
    await runFinalDeletions(h.deps, h.clock.fn());
    const again = await signUp(
      h,
      (await makeInvite(h, await login(h, ownerCreds.email, ownerCreds.password))).code,
      { ...newUser(), email: u.email },
    );
    const d2 = await daily(again);
    const ids = d2.assignments.map((a: { poll: { id: string } }) => a.poll.id);
    for (const a of answered) expect(ids).not.toContain(a.poll.id);
  });
});

describe('announcement and reminder settings (spec §18)', () => {
  it('daily announcement shows once until seen; can be turned off; answering reminder is opt-in', async () => {
    await world();
    const u = await member();
    expect((await daily(u)).announcement.show).toBe(true);
    await h.app.inject({ method: 'POST', url: '/daily/announcement/seen', headers: as(u) });
    expect((await daily(u)).announcement.show).toBe(false);

    const v = await member();
    expect((await daily(v)).reminders.answering).toBe(false);
    const put = await h.app.inject({
      method: 'PUT',
      url: '/me/settings/notifications',
      headers: as(v),
      payload: { dailyPollAnnouncement: false, answeringReminder: true },
    });
    expect(put.json()).toEqual({
      dailyPollAnnouncement: false,
      answeringReminder: true,
      guessingReminder: false,
    });
    const dv = await daily(v);
    expect(dv.announcement.show).toBe(false);
    expect(dv.reminders.answering).toBe(true);
    await answerDaily(v, dv.dailyPoll.poll.id);
    await answerAllSlots(v, dv);
    expect((await daily(v)).reminders.answering).toBe(false); // target met -> suppressed
  });
});

describe('privacy of survey data', () => {
  it('survey_responses holds no raw text column', async () => {
    const cols = await sql<{
      column_name: string;
    }>`SELECT column_name FROM information_schema.columns WHERE table_name = 'survey_responses'`.execute(
      h.db,
    );
    expect(cols.rows.map((c) => c.column_name)).not.toContain('raw_text');
  });
});
