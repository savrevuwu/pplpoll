// Update §6 (Mystery Challenge) with owner-approved G2/G3: objectives, limits, stats.
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

async function pollWithAnswers(dist: Record<string, number>) {
  const poll = await h.db
    .insertInto('polls')
    .values({
      text: `Name something in a bag ${randomUUID().slice(0, 8)}`,
      exact_key: randomUUID(),
      creator_visibility: 'anonymous',
      status: 'survey',
      debut_et_date: '2026-09-01',
      approved_at: new Date('2026-08-01T00:00:00Z'),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  for (const [key, n] of Object.entries(dist)) {
    await sql`
      WITH ids AS (INSERT INTO participation_identities (identity_hmac) SELECT gen_random_uuid()::text FROM generate_series(1, ${n}::int) RETURNING id)
      INSERT INTO survey_responses (poll_id, participation_identity_id, et_date, context, assignment_slot, counts_for_progress, normalized_key, normalization_version, submitted_at)
      SELECT ${poll.id}, id, '2026-09-02', 'assignment', 1, false, ${key}, 1, now() FROM ids
    `.execute(h.db);
  }
  return poll.id;
}
const member = async () =>
  signUp(h, (await makeInvite(h, await login(h, ownerCreds.email, ownerCreds.password))).code);
const startMystery = (s: Session) =>
  h.app.inject({ method: 'POST', url: '/games/mystery', headers: as(s) });
const guess = (s: Session, gameId: string, text: string) =>
  h.app.inject({
    method: 'POST',
    url: `/games/${gameId}/guesses`,
    headers: as(s),
    payload: { text, clientRequestId: randomUUID() },
  });
const stats = async (s: Session) =>
  (await h.app.inject({ method: 'GET', url: '/me/stats', headers: as(s) })).json();

/** Starts a challenge and (test-only) pins its objective so each type can be checked exactly. */
async function challenge(u: Session, objectiveType: string) {
  const g = (await startMystery(u)).json();
  const snap = await h.db
    .selectFrom('games as g')
    .innerJoin('result_snapshots as s', 's.id', 'g.snapshot_id')
    .select(['s.distribution', 's.labels'])
    .where('g.id', '=', g.gameId)
    .executeTakeFirstOrThrow();
  const id = (label: string) => Object.entries(snap.labels).find(([, l]) => l === label)![0];
  const objectives: Record<string, unknown> = {
    top_answer: { type: 'top_answer', groups: [id('Keys')] },
    top_three: { type: 'top_three', groups: [id('Keys'), id('Wallet'), id('Phone')] },
    deep_cut: { type: 'deep_cut', underPercent: 5, groups: [id('Mints')] },
    clean_sweep: { type: 'clean_sweep' },
    efficient: { type: 'efficient', maxGuesses: 3 },
  };
  await h.db
    .updateTable('games')
    .set({ objective: JSON.stringify(objectives[objectiveType]) })
    .where('id', '=', g.gameId)
    .execute();
  return g.gameId as string;
}
const outcome = async (u: Session, id: string) =>
  (await h.app.inject({ method: 'GET', url: `/games/${id}`, headers: as(u) })).json();

describe('starting a Mystery Challenge', () => {
  it('gets a random eligible unplayed poll and an achievable objective instead of the 60% goal', async () => {
    await pollWithAnswers(PURSE);
    await computeSnapshots(h.deps, h.clock.fn());
    const u = await member();
    const g = (await startMystery(u)).json();
    expect(g).toMatchObject({
      mode: 'mystery',
      state: 'active',
      targetPercent: null,
      guessCap: 10,
      maxStrikes: 3,
    });
    expect(['top_answer', 'top_three', 'deep_cut', 'clean_sweep', 'efficient']).toContain(
      g.objective.type,
    );
    expect(typeof g.objective.description).toBe('string');
    expect(JSON.stringify(g)).not.toMatch(/Keys|Wallet|Mints/); // objective never reveals answers
  });

  it('shares the one-active-game rule, the 10-a-day count and played polls with solo; no PP; no survey credit', async () => {
    await pollWithAnswers(PURSE);
    await computeSnapshots(h.deps, h.clock.fn());
    const u = await member();
    const id = await challenge(u, 'top_answer');
    expect(
      (await h.app.inject({ method: 'POST', url: '/games/solo', headers: as(u) })).json().error
        .code,
    ).toBe('ACTIVE_GAME_EXISTS');
    await guess(u, id, 'keys');
    expect(
      (await h.app.inject({ method: 'GET', url: '/games/status', headers: as(u) })).json()
        .gamesUsed,
    ).toBe(1);
    expect(
      (await h.app.inject({ method: 'POST', url: '/games/solo', headers: as(u) })).json().error
        .code,
    ).toBe('NO_ELIGIBLE_POLL');
    expect(
      (await h.app.inject({ method: 'GET', url: '/me/pp', headers: as(u) })).json().balance,
    ).toBe(0);
    expect(
      (await h.app.inject({ method: 'GET', url: '/daily', headers: as(u) })).json().progress
        .completed,
    ).toBe(0);
  });
});

describe('objectives', () => {
  beforeEach(async () => {
    for (let i = 0; i < 3; i++) await pollWithAnswers(PURSE);
    await computeSnapshots(h.deps, h.clock.fn());
  });

  it('Top Answer: completes on finding #1, not on other answers', async () => {
    const u = await member();
    const id = await challenge(u, 'top_answer');
    await guess(u, id, 'wallet');
    expect((await outcome(u, id)).state).toBe('active');
    expect((await guess(u, id, 'keys')).json().game).toMatchObject({
      state: 'ended',
      outcome: 'won',
    });
  });

  it('Top Three: reaching 60% does not end it; all three does', async () => {
    const u = await member();
    const id = await challenge(u, 'top_three');
    await guess(u, id, 'keys');
    await guess(u, id, 'wallet'); // 65%
    expect((await outcome(u, id)).state).toBe('active');
    expect((await guess(u, id, 'phone')).json().game.outcome).toBe('won');
  });

  it('Deep Cut: an answer under 5%', async () => {
    const u = await member();
    const id = await challenge(u, 'deep_cut');
    expect((await guess(u, id, 'mints')).json().game.outcome).toBe('won');
  });

  it('Clean Sweep: one wrong guess fails it right away', async () => {
    const u = await member();
    const id = await challenge(u, 'clean_sweep');
    await guess(u, id, 'keys');
    expect((await guess(u, id, 'banana')).json().game).toMatchObject({
      state: 'ended',
      outcome: 'lost',
    });
  });

  it('Efficient: 60% within the guess budget', async () => {
    const u = await member();
    const win = await challenge(u, 'efficient');
    await guess(u, win, 'keys');
    await guess(u, win, 'gum');
    expect((await guess(u, win, 'wallet')).json().game.outcome).toBe('won'); // 75% in 3
    const lose = await challenge(u, 'efficient');
    await guess(u, lose, 'gum');
    await guess(u, lose, 'mints');
    expect((await guess(u, lose, 'lipstick')).json().game.outcome).toBe('lost'); // budget spent at 20%
  });

  it('the normal three-strike rule still applies', async () => {
    const u = await member();
    const id = await challenge(u, 'top_three');
    for (const w of ['banana', 'rocket', 'umbrella']) await guess(u, id, w);
    expect(await outcome(u, id)).toMatchObject({ state: 'ended', outcome: 'lost', strikes: 3 });
  });
});

describe('Mystery statistics', () => {
  it('tracks attempts, completions, failures and fewest-guess personal bests; rare finds count toward Rarest Correct Guess', async () => {
    for (let i = 0; i < 3; i++) await pollWithAnswers(PURSE);
    await computeSnapshots(h.deps, h.clock.fn());
    const u = await member();
    let id = await challenge(u, 'deep_cut');
    await guess(u, id, 'keys');
    await guess(u, id, 'mints'); // won in 2
    id = await challenge(u, 'deep_cut');
    await guess(u, id, 'mints'); // won in 1
    id = await challenge(u, 'clean_sweep');
    await guess(u, id, 'banana'); // lost
    const s = await stats(u);
    expect(s.mystery).toEqual({
      attempts: 3,
      completions: 2,
      failures: 1,
      byObjective: {
        deep_cut: { completions: 2, failures: 0, fewestGuesses: 1 },
        clean_sweep: { completions: 0, failures: 1, fewestGuesses: null },
      },
    });
    expect(s.solo.gamesPlayed).toBe(0); // separate from solo
    expect(s.rarestCorrectGuess).toBe('4.00%');
  });
});
