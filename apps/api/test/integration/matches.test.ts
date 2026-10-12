// Update §1–§3, §7–§8 with G4, G5, G7; spec §5, §7, §23.3, §23.4 (start rules).
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
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

/** Private room with the given players, started by the first. */
async function room(mode: string, format: string, players: Player[], teams?: (0 | 1)[]) {
  const created = (await post(players[0]!, '/matches/rooms', { mode, format })).json();
  for (const p of players.slice(1)) {
    const r = await post(p, '/matches/rooms/join', { code: created.roomCode.toLowerCase() });
    expect(r.statusCode).toBe(200);
  }
  if (teams)
    for (const [i, p] of players.entries())
      await post(p, `/matches/${created.matchId}/team`, { team: teams[i] });
  const started = await post(players[0]!, `/matches/${created.matchId}/start`);
  expect(started.statusCode, started.body).toBe(200);
  return started.json();
}
/** In Classic, the player whose turn it is. */
async function whoseTurn(players: Player[], matchId: string) {
  const v = await get(players[0]!, `/matches/${matchId}`);
  return players.find((p) => p.username === v.turn.player)!;
}

describe('private rooms and start rules (update §1)', () => {
  it('Head-to-Head needs exactly 2; only the host starts; room codes are case-insensitive', async () => {
    await ready();
    const [a, b, c] = [await member(), await member(), await member()];
    const r = (await post(a, '/matches/rooms', { mode: 'h2h', format: 'classic' })).json();
    expect(r).toMatchObject({
      status: 'lobby',
      isHost: true,
      roomCode: expect.stringMatching(/^[A-Z2-9]{6}$/),
    });
    expect((await post(a, `/matches/${r.matchId}/start`)).json().error.code).toBe(
      'WRONG_PLAYER_COUNT',
    );
    await post(b, '/matches/rooms/join', { code: r.roomCode.toLowerCase() });
    expect((await post(c, '/matches/rooms/join', { code: r.roomCode })).json().error.code).toBe(
      'ROOM_FULL',
    );
    expect((await post(b, `/matches/${r.matchId}/start`)).json().error.code).toBe('HOST_ONLY');
    const started = (await post(a, `/matches/${r.matchId}/start`)).json();
    expect(started).toMatchObject({
      status: 'active',
      mode: 'h2h',
      format: 'classic',
      guessCap: 10,
    });
    expect(started.sides).toHaveLength(2);
  });

  it('Free-for-All never starts with 2; Teams needs exactly 4 with 2 per team', async () => {
    await ready();
    const ps = [await member(), await member(), await member(), await member(), await member()];
    const ffa = (await post(ps[0]!, '/matches/rooms', { mode: 'ffa', format: 'speed' })).json();
    await post(ps[1]!, '/matches/rooms/join', { code: ffa.roomCode });
    expect((await post(ps[0]!, `/matches/${ffa.matchId}/start`)).json().error.code).toBe(
      'WRONG_PLAYER_COUNT',
    );
    await post(ps[0]!, `/matches/${ffa.matchId}/leave-lobby`);
    await post(ps[1]!, `/matches/${ffa.matchId}/leave-lobby`);

    const teams = (await post(ps[0]!, '/matches/rooms', { mode: 'teams', format: 'speed' })).json();
    for (const p of ps.slice(1, 3)) await post(p, '/matches/rooms/join', { code: teams.roomCode });
    expect((await post(ps[0]!, `/matches/${teams.matchId}/start`)).json().error.code).toBe(
      'WRONG_PLAYER_COUNT',
    );
    await post(ps[0]!, `/matches/${teams.matchId}/team`, { team: 0 });
    await post(ps[1]!, `/matches/${teams.matchId}/team`, { team: 0 });
    expect(
      (await post(ps[2]!, `/matches/${teams.matchId}/team`, { team: 0 })).json().error.code,
    ).toBe('TEAM_FULL');
  });

  it('non-players cannot see a match', async () => {
    await ready();
    const [a, b, c] = [await member(), await member(), await member()];
    const m = await room('h2h', 'speed', [a, b]);
    expect(
      (await h.app.inject({ method: 'GET', url: `/matches/${m.matchId}`, headers: as(c) }))
        .statusCode,
    ).toBe(404);
  });

  it('every player must have a poll in common, a daily game left, and no other active game', async () => {
    await ready();
    const [a, b] = [await member(), await member()];
    const solo = (await post(b, '/games/solo')).json();
    const r = (await post(a, '/matches/rooms', { mode: 'h2h', format: 'speed' })).json();
    expect((await post(b, '/matches/rooms/join', { code: r.roomCode })).statusCode).toBe(409); // busy with a solo game
    await post(b, `/games/${solo.gameId}/guesses`, { text: 'keys', clientRequestId: randomUUID() });
    await post(b, `/games/${solo.gameId}/guesses`, {
      text: 'wallet',
      clientRequestId: randomUUID(),
    }); // won; poll now played by b
    await post(b, '/matches/rooms/join', { code: r.roomCode });
    expect((await post(a, `/matches/${r.matchId}/start`)).json().error.code).toBe('NO_SHARED_POLL');
  });
});

describe('Classic: alternating turns, 2-minute clock (update §1, G5)', () => {
  it('only the side whose turn it is may guess; an accepted guess passes the turn; repeats do not', async () => {
    await ready();
    const ps = [await member(), await member()];
    const m = await room('h2h', 'classic', ps);
    const first = await whoseTurn(ps, m.matchId);
    const second = ps.find((p) => p !== first)!;
    expect((await guess(second, m.matchId, 'keys')).json().error.code).toBe('NOT_YOUR_TURN');
    expect((await guess(first, m.matchId, 'keys')).json().result).toBe('correct');
    expect((await whoseTurn(ps, m.matchId)).username).toBe(second.username);
    await guess(second, m.matchId, 'wallet');
    await guess(first, m.matchId, 'phone');
    expect((await guess(second, m.matchId, 'WALLET!')).json().result).toBe('already_guessed');
    expect((await whoseTurn(ps, m.matchId)).username).toBe(second.username); // repeat keeps the turn
  });

  it('a turn not used within 15 s passes with no strike', async () => {
    await ready();
    const ps = [await member(), await member()];
    const m = await room('h2h', 'classic', ps);
    const first = await whoseTurn(ps, m.matchId);
    advance(15_000);
    const v = await get(first, `/matches/${m.matchId}`);
    expect(v.turn.player).not.toBe(first.username);
    expect(v.sides.every((s: { strikes: number }) => s.strikes === 0)).toBe(true);
  });

  it('ends at 2 minutes; higher percentage wins', async () => {
    await ready();
    const ps = [await member(), await member()];
    const m = await room('h2h', 'classic', ps);
    const first = await whoseTurn(ps, m.matchId);
    const second = ps.find((p) => p !== first)!;
    await guess(first, m.matchId, 'keys');
    await guess(second, m.matchId, 'wallet');
    advance(120_000);
    await finishExpiredMatches(h.deps, h.clock.fn());
    const v = await get(first, `/matches/${m.matchId}`);
    expect(v.status).toBe('ended');
    const mine = v.sides[v.mySideIndex];
    expect(mine).toMatchObject({ outcome: 'win', placement: 1, score: '40.00%' });
    expect(v.sides.find((s: { sideIndex: number }) => s.sideIndex !== v.mySideIndex)).toMatchObject(
      { outcome: 'loss', placement: 2 },
    );
  });
});

describe('Speed: simultaneous guessing, 1-minute clock', () => {
  it('opponents earn the same answer independently; equal score -> earlier time wins (update §3)', async () => {
    await ready();
    const [a, b] = [await member(), await member()];
    const m = await room('h2h', 'speed', [a, b]);
    advance(1000);
    await guess(a, m.matchId, 'keys');
    advance(1000);
    expect((await guess(b, m.matchId, 'keys')).json()).toMatchObject({
      result: 'correct',
      percent: '40.00%',
    });
    advance(60_000);
    const v = await get(a, `/matches/${m.matchId}`);
    expect(v.sides[v.mySideIndex]).toMatchObject({ score: '40.00%', outcome: 'win' });
  });

  it('identical results are a real draw', async () => {
    await ready();
    const [a, b] = [await member(), await member()];
    const m = await room('h2h', 'speed', [a, b]);
    advance(60_000);
    const v = await get(a, `/matches/${m.matchId}`);
    expect(
      v.sides.map((s: { outcome: string; placement: number }) => [s.outcome, s.placement]),
    ).toEqual([
      ['draw', 1],
      ['draw', 1],
    ]);
  });

  it('opponents never see guessed words or answer names, only numbered results and percentages', async () => {
    await ready();
    const [a, b] = [await member(), await member()];
    const m = await room('h2h', 'speed', [a, b]);
    await guess(a, m.matchId, 'keys');
    await guess(a, m.matchId, 'zebra');
    await guess(a, m.matchId, 'KEYS');
    const bv = await get(b, `/matches/${m.matchId}`);
    const theirs = bv.sides.find((s: { sideIndex: number }) => s.sideIndex !== bv.mySideIndex);
    expect(theirs.guesses).toEqual([
      { number: 1, result: 'correct', percent: '40.00%' },
      { number: 2, result: 'incorrect' },
    ]);
    expect(JSON.stringify(bv)).not.toMatch(/keys|zebra/i);
    const av = await get(a, `/matches/${m.matchId}`);
    expect(av.sides[av.mySideIndex].guesses.map((g: { text: string }) => g.text)).toEqual([
      'keys',
      'zebra',
      'KEYS',
    ]);
  });

  it('ends early when every side is finished', async () => {
    await ready();
    const [a, b] = [await member(), await member()];
    const m = await room('h2h', 'speed', [a, b]);
    for (const p of [a, b])
      for (const w of ['zebra', 'rocket', 'umbrella']) await guess(p, m.matchId, w);
    expect((await get(a, `/matches/${m.matchId}`)).status).toBe('ended');
  });
});

describe('Teams (update §2)', () => {
  it('shared pool per team, repeats neutral, opponents score the same answer, contributions credited', async () => {
    await ready();
    const ps = [await member(), await member(), await member(), await member()];
    const m = await room('teams', 'speed', ps, [0, 0, 1, 1]);
    const [a1, a2, b1] = [ps[0]!, ps[1]!, ps[2]!];
    expect((await guess(a1, m.matchId, 'keys')).json().result).toBe('correct');
    expect((await guess(a2, m.matchId, 'keys')).json().result).toBe('already_guessed');
    await guess(a2, m.matchId, 'wallet');
    expect((await guess(b1, m.matchId, 'keys')).json()).toMatchObject({
      result: 'correct',
      percent: '40.00%',
    });
    const v = await get(a1, `/matches/${m.matchId}`);
    const mine = v.sides[v.mySideIndex];
    expect(mine.score).toBe('65.00%');
    expect(mine.strikes).toBe(0);
    expect(
      Object.fromEntries(
        mine.contributions.map((c: { username: string; percent: string }) => [
          c.username,
          c.percent,
        ]),
      ),
    ).toEqual({
      [a1.username]: '40.00%',
      [a2.username]: '25.00%',
    });
    // Teammates see each other's words.
    expect(mine.guesses.map((g: { by: string; text: string }) => `${g.by}:${g.text}`)).toContain(
      `${a2.username}:wallet`,
    );
  });

  it("a team's first accepted guess charges every teammate; a side that never guesses is not charged", async () => {
    await ready();
    const ps = [await member(), await member(), await member(), await member()];
    const m = await room('teams', 'speed', ps, [0, 0, 1, 1]);
    await guess(ps[0]!, m.matchId, 'keys');
    advance(60_000);
    await finishExpiredMatches(h.deps, h.clock.fn());
    const used = await Promise.all(ps.map(async (p) => (await get(p, '/games/status')).gamesUsed));
    expect(used).toEqual([1, 1, 0, 0]);
  });

  it('Classic Teams: teams alternate and teammates rotate who submits', async () => {
    await ready();
    const ps = [await member(), await member(), await member(), await member()];
    const m = await room('teams', 'classic', ps, [0, 0, 1, 1]);
    const submitters: string[] = [];
    for (let i = 0; i < 4; i++) {
      const p = await whoseTurn(ps, m.matchId);
      submitters.push(p.username);
      const others = ps.filter((x) => x !== p);
      const r = await guess(others[0]!, m.matchId, 'zz');
      expect(r.json().error.code).toBe('NOT_YOUR_TURN');
      await guess(p, m.matchId, ['keys', 'wallet', 'phone', 'gum'][i]!);
    }
    expect(new Set(submitters).size).toBe(4); // A1, B1, A2, B2 in some order
    const teamOf = (u: string) => (ps.findIndex((p) => p.username === u) < 2 ? 0 : 1);
    expect(submitters.map(teamOf)).toEqual([
      teamOf(submitters[0]!),
      1 - teamOf(submitters[0]!),
      teamOf(submitters[0]!),
      1 - teamOf(submitters[0]!),
    ]);
  });
});

describe('Free-for-All and public matchmaking (spec §7, G7)', () => {
  it('first available players are matched; 1st/2nd/3rd recorded with ties kept', async () => {
    await ready();
    const ps = [await member(), await member(), await member()];
    expect(
      (await post(ps[0]!, '/matchmaking/queue', { mode: 'ffa', format: 'speed' })).json(),
    ).toMatchObject({ queued: true });
    await post(ps[1]!, '/matchmaking/queue', { mode: 'ffa', format: 'speed' });
    const third = (
      await post(ps[2]!, '/matchmaking/queue', { mode: 'ffa', format: 'speed' })
    ).json();
    expect(third.queued).toBe(false);
    const { matchId } = await get(ps[0]!, '/matches/current');
    expect(matchId).toBe(third.matchId);
    await guess(ps[0]!, matchId, 'keys');
    await guess(ps[1]!, matchId, 'wallet');
    await guess(ps[2]!, matchId, 'wallet');
    advance(60_000);
    const v = await get(ps[0]!, `/matches/${matchId}`);
    const byPlayer = Object.fromEntries(
      v.sides.map((s: { players: string[]; placement: number; outcome: string }) => [
        s.players[0],
        [s.placement, s.outcome],
      ]),
    );
    expect(byPlayer[ps[0]!.username]).toEqual([1, 'win']);
    // Same score at the same moment with the same number of guesses: a genuine tie, both 2nd.
    expect(byPlayer[ps[1]!.username]).toEqual([2, 'loss']);
    expect(byPlayer[ps[2]!.username]).toEqual([2, 'loss']);
    const stats = await get(ps[0]!, '/me/stats');
    expect(stats.multiplayer).toMatchObject({
      games: 1,
      wins: 1,
      first: 1,
      byMode: { ffa: { wins: 1 } },
      byFormat: { speed: { games: 1 } },
    });
  });

  it('Free-for-All tiebreaks: earlier time first, then fewer correct guesses', async () => {
    await ready();
    const ps = [await member(), await member(), await member()];
    for (const p of ps) await post(p, '/matchmaking/queue', { mode: 'ffa', format: 'speed' });
    const { matchId } = await get(ps[0]!, '/matches/current');
    await guess(ps[0]!, matchId, 'gum'); // 10% then 15% -> 25% with 2 correct, at t=0
    await guess(ps[0]!, matchId, 'phone');
    advance(1000);
    await guess(ps[1]!, matchId, 'wallet'); // 25% with 1 correct, at t=1s
    advance(1000);
    await guess(ps[2]!, matchId, 'wallet'); // 25% with 1 correct, at t=2s
    advance(60_000);
    const v = await get(ps[0]!, `/matches/${matchId}`);
    const place = Object.fromEntries(
      v.sides.map((s: { players: string[]; placement: number }) => [s.players[0], s.placement]),
    );
    expect([place[ps[0]!.username], place[ps[1]!.username], place[ps[2]!.username]]).toEqual([
      1, 2, 3,
    ]);
  });

  it('Head-to-Head queue pairs two players; can cancel; out-of-games players cannot queue', async () => {
    await ready();
    const [a, b, c] = [await member(), await member(), await member()];
    await post(a, '/matchmaking/queue', { mode: 'h2h', format: 'classic' });
    expect(
      (await h.app.inject({ method: 'DELETE', url: '/matchmaking/queue', headers: as(a) })).json(),
    ).toEqual({ queued: false });
    await post(a, '/matchmaking/queue', { mode: 'h2h', format: 'classic' });
    await post(b, '/matchmaking/queue', { mode: 'h2h', format: 'speed' }); // different format: no match
    expect((await get(a, '/matchmaking/queue')).queued).toBe(true);
    await post(c, '/matchmaking/queue', { mode: 'h2h', format: 'classic' });
    expect((await get(a, '/matches/current')).matchId).not.toBeNull();
    await h.db
      .insertInto('daily_charges')
      .values({ user_id: b.userId, et_date: '2026-10-12', charged: 10 })
      .onConflict((oc) => oc.columns(['user_id', 'et_date']).doUpdateSet({ charged: 10 }))
      .execute();
    await h.app.inject({ method: 'DELETE', url: '/matchmaking/queue', headers: as(b) });
    expect(
      (await post(b, '/matchmaking/queue', { mode: 'h2h', format: 'speed' })).json().error.code,
    ).toBe('DAILY_LIMIT_REACHED');
  });
});

describe('records', () => {
  it('Rarest Correct Guess credits the teammate who submitted it', async () => {
    await ready();
    const ps = [await member(), await member(), await member(), await member()];
    const m = await room('teams', 'speed', ps, [0, 0, 1, 1]);
    await guess(ps[1]!, m.matchId, 'mints');
    advance(60_000);
    await finishExpiredMatches(h.deps, h.clock.fn());
    expect((await get(ps[1]!, '/me/stats')).rarestCorrectGuess).toBe('4.00%');
    expect((await get(ps[0]!, '/me/stats')).rarestCorrectGuess).toBeNull();
  });
});

describe('live updates over WebSocket', () => {
  it('a subscribed player is told when the match changes (ids only, no game data)', async () => {
    await ready();
    const [a, b] = [await member(), await member()];
    const m = await room('h2h', 'speed', [a, b]);
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (h.app.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: b.cookie } });
    const messages: Record<string, unknown>[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ subscribe: m.matchId })));
      ws.on('message', (d) => {
        const msg = JSON.parse(String(d));
        messages.push(msg);
        if (msg.type === 'subscribed') void guess(a, m.matchId, 'keys');
        if (msg.type === 'match.updated') resolve();
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('no update')), 5000);
    });
    ws.close();
    expect(messages.find((x) => x.type === 'match.updated')).toEqual({
      type: 'match.updated',
      matchId: m.matchId,
    });
    expect(JSON.stringify(messages)).not.toMatch(/keys/i);
  });

  it("cannot subscribe to someone else's match", async () => {
    await ready();
    const [a, b, c] = [await member(), await member(), await member()];
    const m = await room('h2h', 'speed', [a, b]);
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (h.app.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: c.cookie } });
    const msg = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ subscribe: m.matchId })));
      ws.on('message', (d) => resolve(JSON.parse(String(d))));
      ws.on('error', reject);
    });
    ws.close();
    expect(msg).toEqual({ type: 'error', code: 'NOT_FOUND' });
  });
});
