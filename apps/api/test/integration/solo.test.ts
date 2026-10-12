// Spec §4–§6, §17, §23.1–§23.3, update §8–§9 — AT-04, AT-08..14, AT-28 (guessing).
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { computeSnapshots } from '../../src/index.js';
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
let ownerCreds: { email: string; password: string };

beforeEach(async () => {
  if (h) await h.close();
  h = await createHarness();
  h.clock.set('2026-10-12T16:00:00Z');
  ownerCreds = await createOwner(h);
});
afterAll(() => h.close());

const PURSE = { keys: 40, wallet: 25, phone: 15, gum: 10, lipstick: 6, mints: 4 };

/** Test fixture: a survey poll with genuine-looking answers already collected. */
async function pollWithAnswers(dist: Record<string, number>) {
  const poll = await h.db
    .insertInto('polls')
    .values({
      text: `Name something in a purse ${randomUUID().slice(0, 8)}`,
      exact_key: randomUUID(),
      creator_visibility: 'anonymous',
      status: 'survey',
      debut_et_date: '2026-09-01',
      approved_at: new Date('2026-08-01T00:00:00Z'),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await addAnswers(poll.id, dist);
  return poll.id;
}
async function addAnswers(pollId: string, dist: Record<string, number>) {
  for (const [key, n] of Object.entries(dist)) {
    await sql`
      WITH ids AS (INSERT INTO participation_identities (identity_hmac) SELECT gen_random_uuid()::text FROM generate_series(1, ${n}::int) RETURNING id)
      INSERT INTO survey_responses (poll_id, participation_identity_id, et_date, context, assignment_slot, counts_for_progress, normalized_key, normalization_version, submitted_at)
      SELECT ${pollId}, id, '2026-09-02', 'assignment', 1, false, ${key}, 1, now() FROM ids
    `.execute(h.db);
  }
}
const snapshots = () => computeSnapshots(h.deps, h.clock.fn());
const member = async () =>
  signUp(h, (await makeInvite(h, await login(h, ownerCreds.email, ownerCreds.password))).code);
const start = (s: Session) => h.app.inject({ method: 'POST', url: '/games/solo', headers: as(s) });
const guess = (s: Session, gameId: string, text: string, clientRequestId = randomUUID()) =>
  h.app.inject({
    method: 'POST',
    url: `/games/${gameId}/guesses`,
    headers: as(s),
    payload: { text, clientRequestId },
  });
const leave = (s: Session, gameId: string) =>
  h.app.inject({
    method: 'POST',
    url: `/games/${gameId}/leave`,
    headers: as(s),
    payload: { confirm: true },
  });
/** Uses one daily game: three wrong guesses end it as a loss. */
async function burnGame(s: Session) {
  const g = (await start(s)).json();
  for (const w of ['banana', 'rocket', 'umbrella']) await guess(s, g.gameId, w);
  return g.gameId as string;
}
const status = async (s: Session) =>
  (await h.app.inject({ method: 'GET', url: '/games/status', headers: as(s) })).json();

describe('result snapshots (§4, §23.1)', () => {
  it('computes K, guess cap and eligibility; under 100 respondents is survey-only', async () => {
    const ok = await pollWithAnswers(PURSE);
    const small = await pollWithAnswers({ keys: 60, wallet: 39 });
    await snapshots();
    const s = await h.db
      .selectFrom('result_snapshots')
      .selectAll()
      .where('poll_id', '=', ok)
      .executeTakeFirstOrThrow();
    expect(s).toMatchObject({
      respondents: 100,
      k: 2,
      guess_cap: 10,
      eligible: true,
      version: 1,
      et_date: '2026-10-12',
    });
    const t = await h.db
      .selectFrom('result_snapshots')
      .selectAll()
      .where('poll_id', '=', small)
      .executeTakeFirstOrThrow();
    expect(t).toMatchObject({
      respondents: 99,
      eligible: false,
      ineligible_reason: 'too_few_respondents',
    });
  });

  it('K=18 stays survey-only and becomes playable later when K drops (AT-10)', async () => {
    const flat: Record<string, number> = {};
    for (let i = 0; i < 50; i++) flat[`opt${i}word`] = 2; // 50 groups x 2 = 100 respondents, K = 30
    const p = await pollWithAnswers(flat);
    await snapshots();
    const s1 = await h.db
      .selectFrom('result_snapshots')
      .selectAll()
      .where('poll_id', '=', p)
      .executeTakeFirstOrThrow();
    expect(s1.eligible).toBe(false);
    expect(s1.k).toBeGreaterThan(17);
    await addAnswers(p, { opt0word: 80 }); // one answer becomes dominant: 82 of 180
    h.clock.set('2026-10-13T16:00:00Z');
    await snapshots();
    const s2 = await h.db
      .selectFrom('result_snapshots')
      .selectAll()
      .where('poll_id', '=', p)
      .where('version', '=', 2)
      .executeTakeFirstOrThrow();
    expect(s2).toMatchObject({ eligible: true, k: 14, guess_cap: 17 });
  });

  it('is once per ET day, immutable, and folds plurals', async () => {
    const p = await pollWithAnswers({ ...PURSE, key: 5 }); // "key" + "keys" -> one group of 45
    await snapshots();
    await snapshots();
    const rows = await h.db
      .selectFrom('result_snapshots')
      .selectAll()
      .where('poll_id', '=', p)
      .execute();
    expect(rows).toHaveLength(1);
    expect(Object.values(rows[0]!.distribution).sort((a, b) => b - a)[0]).toBe(45);
    await expect(
      h.db.updateTable('result_snapshots').set({ respondents: 1 }).execute(),
    ).rejects.toThrow(/append-only/);
  });

  it('staff merges (synonyms) apply at the next snapshot', async () => {
    const p = await pollWithAnswers({ ...PURSE, cellphone: 5 });
    const owner = await login(h, ownerCreds.email, ownerCreds.password);
    const mod = await member();
    await setRole(h, owner, mod.userId, 'moderator');
    const keys = (
      await h.app.inject({ method: 'GET', url: `/staff/polls/${p}/answer-keys`, headers: as(mod) })
    ).json().keys;
    expect(keys.find((k: { key: string }) => k.key === 'cellphone')).toMatchObject({
      count: 5,
      group: 'cellphone',
    });
    const m = await h.app.inject({
      method: 'POST',
      url: `/staff/polls/${p}/answer-groups/merge`,
      headers: as(mod),
      payload: { keys: ['cellphone'], into: 'phone' },
    });
    expect(m.statusCode).toBe(200);
    const member1 = await member();
    expect(
      (
        await h.app.inject({
          method: 'GET',
          url: `/staff/polls/${p}/answer-keys`,
          headers: as(member1),
        })
      ).statusCode,
    ).toBe(403);
    h.clock.set('2026-10-13T16:00:00Z');
    await snapshots();
    const s = await h.db
      .selectFrom('result_snapshots')
      .selectAll()
      .where('poll_id', '=', p)
      .orderBy('version', 'desc')
      .executeTakeFirstOrThrow();
    expect(Object.values(s.distribution)).toContain(20);
  });
});

describe('solo game (§5, §6)', () => {
  it('no eligible poll -> clear empty state', async () => {
    await pollWithAnswers({ keys: 50 });
    await snapshots();
    const u = await member();
    expect((await start(u)).json().error.code).toBe('NO_ELIGIBLE_POLL');
  });

  it('plays to a win: correct answers show their percentages; 60% wins', async () => {
    await pollWithAnswers(PURSE);
    await snapshots();
    const u = await member();
    const g = (await start(u)).json();
    expect(g).toMatchObject({
      state: 'active',
      targetPercent: 60,
      guessCap: 10,
      strikes: 0,
      remaining: 10,
      found: [],
    });
    const r1 = (await guess(u, g.gameId, 'My Keys!')).json();
    expect(r1).toMatchObject({ result: 'correct', answer: 'Keys', percent: '40.00%' });
    const r2 = (await guess(u, g.gameId, 'walet')).json(); // one typo
    expect(r2).toMatchObject({ result: 'correct', answer: 'Wallet', percent: '25.00%' });
    expect(r2.game).toMatchObject({ state: 'ended', outcome: 'won', score: '65.00%' });
  });

  it('three wrong guesses lose; the full answer list is never revealed', async () => {
    await pollWithAnswers(PURSE);
    await snapshots();
    const u = await member();
    const g = (await start(u)).json();
    await guess(u, g.gameId, 'Gum');
    for (const w of ['banana', 'rocket', 'umbrella']) await guess(u, g.gameId, w);
    const end = (
      await h.app.inject({ method: 'GET', url: `/games/${g.gameId}`, headers: as(u) })
    ).json();
    expect(end).toMatchObject({
      state: 'ended',
      outcome: 'lost',
      strikes: 3,
      found: [{ answer: 'Gum', percent: '10.00%' }],
    });
    const body = JSON.stringify(end);
    for (const hidden of ['Keys', 'Wallet', 'Phone', 'Lipstick', 'Mints'])
      expect(body).not.toContain(hidden);
  });

  it('repeat guesses are neutral and not numbered; retries with the same request id are idempotent', async () => {
    await pollWithAnswers(PURSE);
    await snapshots();
    const u = await member();
    const g = (await start(u)).json();
    await guess(u, g.gameId, 'keys');
    expect((await guess(u, g.gameId, 'KEYS')).json().result).toBe('already_guessed');
    await guess(u, g.gameId, 'banana');
    expect((await guess(u, g.gameId, 'Banana!')).json().result).toBe('already_guessed');
    const id = randomUUID();
    const a = await Promise.all([
      guess(u, g.gameId, 'rocket', id),
      guess(u, g.gameId, 'rocket', id),
      guess(u, g.gameId, 'rocket', id),
    ]);
    expect(new Set(a.map((r) => r.json().result))).toEqual(new Set(['incorrect']));
    const state = (
      await h.app.inject({ method: 'GET', url: `/games/${g.gameId}`, headers: as(u) })
    ).json();
    expect(state).toMatchObject({ strikes: 2, remaining: 7 });
    expect(state.myGuesses.map((x: { number: number | null }) => x.number)).toEqual([
      1,
      null,
      2,
      null,
      3,
    ]);
  });

  it('one active game per account, even with simultaneous starts', async () => {
    await pollWithAnswers(PURSE);
    await pollWithAnswers(PURSE);
    await snapshots();
    const u = await member();
    const results = await Promise.all(Array.from({ length: 5 }, () => start(u)));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(
      results
        .filter((r) => r.statusCode === 409)
        .every((r) => r.json().error.code === 'ACTIVE_GAME_EXISTS'),
    ).toBe(true);
  });

  it('opening a game does not mark it played or charge; leaving before a guess releases it', async () => {
    const p = await pollWithAnswers(PURSE);
    await snapshots();
    const u = await member();
    const g = (await start(u)).json();
    await leave(u, g.gameId);
    expect((await status(u)).gamesUsed).toBe(0);
    expect(
      await h.db
        .selectFrom('played_polls')
        .select('poll_id')
        .where('user_id', '=', u.userId)
        .execute(),
    ).toHaveLength(0);
    const again = (await start(u)).json();
    expect(again.gameId).not.toBe(g.gameId);
    const pollOf = await h.db
      .selectFrom('games')
      .select('poll_id')
      .where('id', '=', again.gameId)
      .executeTakeFirstOrThrow();
    expect(pollOf.poll_id).toBe(p); // still eligible: never played
  });

  it('first accepted guess charges once and marks played; played polls are skipped next time', async () => {
    await pollWithAnswers(PURSE);
    await snapshots();
    const u = await member();
    const g = (await start(u)).json();
    expect((await guess(u, g.gameId, 'keys')).statusCode).toBe(200);
    await guess(u, g.gameId, 'banana');
    expect((await status(u)).gamesUsed).toBe(1);
    await guess(u, g.gameId, 'rocket');
    await guess(u, g.gameId, 'umbrella'); // 3rd strike ends it
    expect((await start(u)).json().error.code).toBe('NO_ELIGIBLE_POLL');
  });

  it('solo play never counts toward the 11 daily surveys or gives PP', async () => {
    await pollWithAnswers(PURSE);
    await snapshots();
    const u = await member();
    const g = (await start(u)).json();
    await guess(u, g.gameId, 'keys');
    await guess(u, g.gameId, 'wallet');
    const d = (await h.app.inject({ method: 'GET', url: '/daily', headers: as(u) })).json();
    expect(d.progress.completed).toBe(0);
    expect(
      (await h.app.inject({ method: 'GET', url: '/me/pp', headers: as(u) })).json().balance,
    ).toBe(0);
  });

  it('a game keeps its frozen snapshot even after a new day publishes new results', async () => {
    const p = await pollWithAnswers(PURSE);
    await snapshots();
    const u = await member();
    const g = (await start(u)).json();
    await addAnswers(p, { mints: 100 });
    h.clock.set('2026-10-13T16:00:00Z');
    await snapshots();
    const r = (await guess(u, g.gameId, 'mints')).json();
    expect(r.percent).toBe('4.00%'); // not 52% from the new snapshot
  });
});

describe('daily guessing allowance (§23.3, AT-12..14)', () => {
  it('10 charged games per day; the 11th cannot start; streak advances at 10', async () => {
    for (let i = 0; i < 11; i++) await pollWithAnswers(PURSE);
    await snapshots();
    const u = await member();
    for (let i = 0; i < 10; i++) {
      await burnGame(u);
    }
    expect(await status(u)).toMatchObject({ gamesUsed: 10, gamesLeft: 0 });
    expect((await start(u)).json().error.code).toBe('DAILY_LIMIT_REACHED');
    const streaks = (
      await h.app.inject({ method: 'GET', url: '/me/streaks', headers: as(u) })
    ).json();
    expect(streaks.guessing).toMatchObject({ current: 1, longest: 1 });
  });

  it('a game in progress may finish after the 10th charge', async () => {
    for (let i = 0; i < 10; i++) await pollWithAnswers(PURSE);
    await snapshots();
    const u = await member();
    for (let i = 0; i < 9; i++) {
      await burnGame(u);
    }
    const last = (await start(u)).json();
    await guess(u, last.gameId, 'keys'); // 10th charge
    expect((await guess(u, last.gameId, 'wallet')).json().game.outcome).toBe('won');
  });

  it('started 11:55 PM, first guess after midnight: charged once to the new date', async () => {
    await pollWithAnswers(PURSE);
    await snapshots();
    const u = await member();
    h.clock.set('2026-10-13T03:55:00Z'); // Oct 12, 11:55 PM EDT
    const g = (await start(u)).json();
    h.clock.set('2026-10-13T04:01:00Z'); // Oct 13, 12:01 AM EDT
    await guess(u, g.gameId, 'keys');
    await guess(u, g.gameId, 'banana');
    const charges = await h.db
      .selectFrom('daily_charges')
      .selectAll()
      .where('user_id', '=', u.userId)
      .execute();
    expect(charges).toEqual([{ user_id: u.userId, et_date: '2026-10-13', charged: 1 }]);
  });

  it('cross-midnight with the new day already full: the guess is refused and the game is released safely', async () => {
    await pollWithAnswers(PURSE);
    await snapshots();
    const u = await member();
    h.clock.set('2026-10-13T03:55:00Z');
    const g = (await start(u)).json();
    await h.db
      .insertInto('daily_charges')
      .values({ user_id: u.userId, et_date: '2026-10-13', charged: 10 })
      .execute(); // simulate a full new day
    h.clock.set('2026-10-13T04:01:00Z');
    const r = await guess(u, g.gameId, 'keys');
    expect(r.json().error.code).toBe('DAILY_LIMIT_REACHED');
    const game = (
      await h.app.inject({ method: 'GET', url: `/games/${g.gameId}`, headers: as(u) })
    ).json();
    expect(game).toMatchObject({ state: 'ended', outcome: 'released', found: [] });
    expect(
      await h.db
        .selectFrom('played_polls')
        .select('poll_id')
        .where('user_id', '=', u.userId)
        .execute(),
    ).toHaveLength(0);
  });
});

describe('replay (§23.2, AT-11)', () => {
  it('a played poll returns only after 30 days, 20% more respondents and a real change', async () => {
    const p = await pollWithAnswers(PURSE);
    await snapshots();
    const u = await member();
    const g = (await start(u)).json();
    await guess(u, g.gameId, 'keys');
    await guess(u, g.gameId, 'wallet');

    h.clock.set('2026-11-12T16:00:00Z'); // 31 days later, but no new answers
    await snapshots();
    let fresh = await login(h, u.email, u.password);
    expect((await start(fresh)).json().error.code).toBe('NO_ELIGIBLE_POLL');

    await addAnswers(p, { wallet: 30 }); // 130 respondents; wallet 25% -> 42%
    h.clock.set('2026-11-13T16:00:00Z');
    await snapshots();
    fresh = await login(h, u.email, u.password);
    const again = (await start(fresh)).json();
    expect(again.state).toBe('active');
    expect(
      (
        await h.db
          .selectFrom('games')
          .select('poll_id')
          .where('id', '=', again.gameId)
          .executeTakeFirstOrThrow()
      ).poll_id,
    ).toBe(p);
  });
});

describe('Rarest Correct Guess (update §8, §9)', () => {
  it('records the lowest frozen share, shows it on the profile, and the record badge is shared on ties', async () => {
    await pollWithAnswers(PURSE);
    await pollWithAnswers(PURSE);
    await snapshots();
    const a = await member();
    const b = await member();
    for (const u of [a, b]) {
      const g = (await start(u)).json();
      await guess(u, g.gameId, 'mints'); // 4%
      await guess(u, g.gameId, 'keys');
      await guess(u, g.gameId, 'wallet'); // 69% -> won
    }
    expect(
      (await h.app.inject({ method: 'GET', url: '/me/stats', headers: as(a) })).json(),
    ).toMatchObject({
      solo: { gamesPlayed: 1, wins: 1, losses: 0 },
      rarestCorrectGuess: '4.00%',
      rarestGuessRecordHolder: true,
    });
    const rec = (
      await h.app.inject({ method: 'GET', url: '/records/rarest-guess', headers: as(a) })
    ).json();
    expect(rec).toEqual({ percent: '4.00%', holders: [a.username, b.username].sort() });
    const prof = (
      await h.app.inject({ method: 'GET', url: `/users/${b.username}`, headers: as(a) })
    ).json();
    expect(prof).toMatchObject({ rarestCorrectGuess: '4.00%', rarestGuessRecordHolder: true });
    expect(JSON.stringify(rec) + JSON.stringify(prof)).not.toMatch(/mints/i);
  });

  it('a strictly rarer valid guess takes the badge; the previous holder keeps their stat', async () => {
    await pollWithAnswers(PURSE);
    await pollWithAnswers({ keys: 50, wallet: 30, phone: 17, gum: 3 }); // gum 3%
    await snapshots();
    const a = await member();
    const b = await member();
    let g = (await start(a)).json();
    // a plays whichever poll; force each player onto a specific poll by playing both
    const playUntilRare = async (u: Session, target: string) => {
      for (let i = 0; i < 2; i++) {
        g = (await start(u)).json();
        await guess(u, g.gameId, target);
        await guess(u, g.gameId, 'keys');
        await guess(u, g.gameId, 'wallet');
        await guess(u, g.gameId, 'phone');
      }
    };
    await leave(a, g.gameId);
    await playUntilRare(a, 'mints');
    const before = (await h.app.inject({ method: 'GET', url: '/me/stats', headers: as(a) })).json();
    expect(before.rarestCorrectGuess).toBe('4.00%');
    await playUntilRare(b, 'gum');
    const bs = (await h.app.inject({ method: 'GET', url: '/me/stats', headers: as(b) })).json();
    expect(bs).toMatchObject({ rarestCorrectGuess: '3.00%', rarestGuessRecordHolder: true });
    const as2 = (await h.app.inject({ method: 'GET', url: '/me/stats', headers: as(a) })).json();
    expect(as2).toMatchObject({ rarestCorrectGuess: '4.00%', rarestGuessRecordHolder: false });
  });

  it('after guessing, a solo game cannot be left: it is saved and resumes later, even the next day (S1)', async () => {
    await pollWithAnswers(PURSE);
    await pollWithAnswers(PURSE);
    await snapshots();
    const u = await member();
    const g = (await start(u)).json();
    await guess(u, g.gameId, 'mints');
    const left = await leave(u, g.gameId);
    expect(left.statusCode).toBe(409);
    expect(left.json().error).toMatchObject({ code: 'GAME_IN_PROGRESS', gameId: g.gameId });
    const other = await start(u);
    expect(other.json().error).toMatchObject({ code: 'ACTIVE_GAME_EXISTS', gameId: g.gameId });
    expect((await status(u)).activeGameId).toBe(g.gameId);
    expect(
      (await h.app.inject({ method: 'GET', url: '/me/stats', headers: as(u) })).json()
        .rarestCorrectGuess,
    ).toBeNull();

    h.clock.set('2026-10-14T16:00:00Z'); // two days later
    const fresh = await login(h, u.email, u.password);
    const resumed = (
      await h.app.inject({ method: 'GET', url: `/games/${g.gameId}`, headers: as(fresh) })
    ).json();
    expect(resumed).toMatchObject({
      state: 'active',
      found: [{ answer: 'Mints', percent: '4.00%' }],
    });
    await guess(fresh, g.gameId, 'keys');
    expect((await guess(fresh, g.gameId, 'wallet')).json().game.outcome).toBe('won');
    expect(
      (await h.app.inject({ method: 'GET', url: '/me/stats', headers: as(fresh) })).json(),
    ).toMatchObject({
      solo: { wins: 1 },
      rarestCorrectGuess: '4.00%',
    });
    // Charged once, on the day of the first guess.
    const charges = await h.db
      .selectFrom('daily_charges')
      .selectAll()
      .where('user_id', '=', u.userId)
      .execute();
    expect(charges.map((c) => [c.et_date, c.charged])).toEqual([['2026-10-12', 1]]);
  });
});
