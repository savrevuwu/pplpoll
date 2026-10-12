// Update §4 (Best-of-3/5) with G1, G8, G11.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { computeSnapshots } from '../../src/index.js';
import { finishExpiredMatches } from '../../src/modules/matches/service.js';
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

async function pollWithAnswers(dist: Record<string, number> = PURSE) {
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
  for (const [key, n] of Object.entries(dist)) {
    await sql`
      WITH ids AS (INSERT INTO participation_identities (identity_hmac) SELECT gen_random_uuid()::text FROM generate_series(1, ${n}::int) RETURNING id)
      INSERT INTO survey_responses (poll_id, participation_identity_id, et_date, context, assignment_slot, counts_for_progress, normalized_key, normalization_version, submitted_at)
      SELECT ${poll.id}, id, '2026-09-02', 'assignment', 1, false, ${key}, 1, now() FROM ids
    `.execute(h.db);
  }
  return poll.id;
}
async function ready(polls = 1) {
  for (let i = 0; i < polls; i++) await pollWithAnswers();
  await computeSnapshots(h.deps, h.clock.fn());
}
type Player = Session & { username: string; email: string; password: string };
const member = async (): Promise<Player> =>
  signUp(h, (await makeInvite(h, await login(h, ownerCreds.email, ownerCreds.password))).code);
const post = (s: Session, url: string, payload: unknown = {}) =>
  h.app.inject({ method: 'POST', url, headers: as(s), payload: payload as object });
const get = async (s: Session, url: string) =>
  (await h.app.inject({ method: 'GET', url, headers: as(s) })).json();
const guess = (s: Session, matchId: string, text: string) =>
  post(s, `/matches/${matchId}/guesses`, { text, clientRequestId: randomUUID() });
const advance = (ms: number) => h.clock.advance(ms);

async function seriesRoom(mode: string, players: Player[], bestOf: 3 | 5, teams?: (0 | 1)[]) {
  const created = (
    await post(players[0]!, '/matches/rooms', { mode, format: 'speed', bestOf })
  ).json();
  for (const p of players.slice(1))
    await post(p, '/matches/rooms/join', { code: created.roomCode });
  if (teams)
    for (const [i, p] of players.entries())
      await post(p, `/matches/${created.matchId}/team`, { team: teams[i] });
  const r = await post(players[0]!, `/matches/${created.matchId}/start`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
/** Ends the current round after the given guesses; returns the next round's match id (or null). */
async function playRound(p: Player, matchId: string, guesses: [Player, string][]) {
  for (const [who, text] of guesses) await guess(who, matchId, text);
  advance(60_000);
  await finishExpiredMatches(h.deps, h.clock.fn());
  return (await get(p, '/matches/current')).matchId as string | null;
}
const startNextRound = () => advance(10_000);

describe('Best-of series (update §4)', () => {
  it('only Head-to-Head and Teams offer series', async () => {
    await ready();
    const a = await member();
    expect(
      (await post(a, '/matches/rooms', { mode: 'ffa', format: 'speed', bestOf: 3 })).json().error
        .code,
    ).toBe('BEST_OF_NOT_ALLOWED');
    expect(
      (await post(a, '/matchmaking/queue', { mode: 'ffa', format: 'speed', bestOf: 5 })).json()
        .error.code,
    ).toBe('BEST_OF_NOT_ALLOWED');
  });

  it('Best-of-3: rounds use different polls, a break between rounds, majority wins, one game in stats', async () => {
    await ready(3);
    const [a, b] = [await member(), await member()];
    const r1 = await seriesRoom('h2h', [a, b], 3);
    expect(r1.series).toMatchObject({ bestOf: 3, status: 'active', wins: [0, 0] });
    const aSide = r1.mySideIndex;
    const r2 = await playRound(a, r1.matchId, [[a, 'keys']]);
    expect(r2).not.toBe(r1.matchId);
    const between = await get(a, `/matches/${r2}`);
    expect(between.question).toBeNull(); // hidden during the break
    expect((await guess(a, r2!, 'keys')).json().error.code).toBe('ROUND_NOT_STARTED');
    const wins = between.series.wins;
    expect(wins[aSide]).toBe(1);
    startNextRound();
    expect((await get(a, `/matches/${r2}`)).question).not.toBeNull();
    const after = await playRound(a, r2!, [[a, 'keys']]);
    expect(after).toBeNull(); // series over
    const v = await get(a, `/matches/${r2}`);
    expect(v.series).toMatchObject({ status: 'ended', winnerSideIndex: aSide });
    const { series_id } = await h.db
      .selectFrom('matches')
      .select('series_id')
      .where('id', '=', r1.matchId)
      .executeTakeFirstOrThrow();
    const polls = await h.db
      .selectFrom('matches')
      .select('poll_id')
      .where('series_id', '=', series_id!)
      .execute();
    expect(new Set(polls.map((p) => p.poll_id)).size).toBe(2);
    expect((await get(a, '/me/stats')).multiplayer).toMatchObject({ games: 1, wins: 1 });
    expect((await get(b, '/me/stats')).multiplayer).toMatchObject({ games: 1, losses: 1 });
  });

  it('a drawn round does not count; another round is played (G8)', async () => {
    await ready(4);
    const [a, b] = [await member(), await member()];
    const r1 = await seriesRoom('h2h', [a, b], 3);
    const r2 = await playRound(a, r1.matchId, []); // nobody guesses: draw
    expect(r2).not.toBeNull();
    startNextRound();
    expect((await get(a, `/matches/${r2}`)).series.wins).toEqual([0, 0]);
    const r3 = await playRound(a, r2!, [[a, 'keys']]);
    startNextRound();
    const done = await playRound(a, r3!, [[a, 'keys']]);
    expect(done).toBeNull();
    expect((await get(a, `/matches/${r3}`)).series.rounds).toHaveLength(3);
  });

  it('if no poll is left that everyone may play, the series ends with no winner and does not count', async () => {
    await ready(1);
    const [a, b] = [await member(), await member()];
    const r1 = await seriesRoom('h2h', [a, b], 3);
    expect(await playRound(a, r1.matchId, [[a, 'keys']])).toBeNull();
    expect((await get(a, `/matches/${r1.matchId}`)).series).toMatchObject({
      status: 'no_contest',
      winnerSideIndex: null,
    });
    expect((await get(a, '/me/stats')).multiplayer.games).toBe(0);
  });

  it('you need enough daily games for the whole series (G1)', async () => {
    await ready(3);
    const [a, b] = [await member(), await member()];
    await h.db
      .insertInto('daily_charges')
      .values({ user_id: b.userId, et_date: '2026-10-12', charged: 8 })
      .execute();
    expect(
      (await post(b, '/matchmaking/queue', { mode: 'h2h', format: 'speed', bestOf: 3 })).json()
        .error.code,
    ).toBe('DAILY_LIMIT_REACHED');
    expect(
      (await post(b, '/matchmaking/queue', { mode: 'h2h', format: 'speed', bestOf: 1 })).json()
        .queued,
    ).toBe(true);
    await h.app.inject({ method: 'DELETE', url: '/matchmaking/queue', headers: as(b) });
    const created = (
      await post(a, '/matches/rooms', { mode: 'h2h', format: 'speed', bestOf: 3 })
    ).json();
    await post(b, '/matches/rooms/join', { code: created.roomCode });
    expect((await post(a, `/matches/${created.matchId}/start`)).json().error.code).toBe(
      'PLAYER_UNAVAILABLE',
    );
  });

  it('public matchmaking keeps Best-of queues separate', async () => {
    await ready(3);
    const [a, b, c] = [await member(), await member(), await member()];
    await post(a, '/matchmaking/queue', { mode: 'h2h', format: 'speed', bestOf: 3 });
    await post(b, '/matchmaking/queue', { mode: 'h2h', format: 'speed' });
    expect((await get(a, '/matchmaking/queue')).queued).toBe(true);
    await post(c, '/matchmaking/queue', { mode: 'h2h', format: 'speed', bestOf: 3 });
    const { matchId } = await get(a, '/matches/current');
    expect((await get(c, `/matches/${matchId}`)).series.bestOf).toBe(3);
  });

  it('Teams Best-of-3 keeps the same teams every round', async () => {
    await ready(3);
    const ps = [await member(), await member(), await member(), await member()];
    const r1 = await seriesRoom('teams', ps, 3, [0, 0, 1, 1]);
    const r2 = await playRound(ps[0]!, r1.matchId, [[ps[0]!, 'keys']]);
    startNextRound();
    const v = await get(ps[1]!, `/matches/${r2}`);
    const mine = v.sides[v.mySideIndex].players.sort();
    expect(mine).toEqual([ps[0]!.username, ps[1]!.username].sort());
  });
});
