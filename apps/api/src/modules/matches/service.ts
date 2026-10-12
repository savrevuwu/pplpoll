import { randomInt } from 'node:crypto';
import type { Database } from '@pplpoll/db';
import {
  CLASSIC_TURN_MS,
  cleanAnswer,
  etDate,
  formatPercent,
  GuessBoard,
  MATCH_DURATION_MS,
  matchGuess,
  MAX_STRIKES,
  nextUnfinished,
  outcomes,
  placements,
  rankStandings,
  replayEligible,
  share,
  validPlayerCount,
  type MatchFormat,
  type MatchMode,
} from '@pplpoll/domain';
import { sql, type Selectable, type Transaction } from 'kysely';
import { audit } from '../../core/audit.js';
import type { AppDeps } from '../../core/deps.js';
import { AppError, errors, isUniqueViolation } from '../../core/errors.js';
import {
  chargedOn,
  chargeParticipant,
  DAILY_GAME_LIMIT,
  endParticipationRow,
  recordRarest,
  reserve,
} from '../allowance/service.js';

type Trx = Transaction<Database>;
type MatchRow = Selectable<Database['matches']>;

const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const busy = () =>
  new AppError(409, 'ALREADY_BUSY', 'Finish your current game, lobby or queue first');
const unavailable = () =>
  new AppError(
    409,
    'PLAYER_UNAVAILABLE',
    "Someone in this match can't play right now (busy or out of games today)",
  );
const noSharedPoll = () =>
  new AppError(409, 'NO_SHARED_POLL', "There's no poll every player can play right now");

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

/** Changes publish only after the transaction commits. */
class Pending {
  readonly matches = new Set<string>();
  readonly users = new Map<string, { type: string; matchId?: string }>();
  flush(deps: AppDeps) {
    for (const m of this.matches) deps.events.matchUpdated(m);
    for (const [u, e] of this.users) deps.events.userEvent(u, e);
  }
}

async function bump(trx: Trx, matchId: string, pending: Pending) {
  await trx
    .updateTable('matches')
    .set((eb) => ({ state_version: eb('state_version', '+', 1) }))
    .where('id', '=', matchId)
    .execute();
  pending.matches.add(matchId);
}

async function loadMatch(trx: Trx, matchId: string, lock = false) {
  let q = trx.selectFrom('matches').selectAll().where('id', '=', matchId);
  if (lock) q = q.forUpdate();
  const m = await q.executeTakeFirst();
  if (!m) throw errors.notFound();
  return m;
}

async function requirePlayer(trx: Trx, matchId: string, userId: string) {
  const p = await trx
    .selectFrom('match_players')
    .selectAll()
    .where('match_id', '=', matchId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  // Not a participant: indistinguishable from a match that doesn't exist.
  if (!p) throw errors.notFound();
  return p;
}

/** In a game, an open lobby, or the public queue. */
async function isBusy(trx: Trx, userId: string): Promise<boolean> {
  const active = await trx
    .selectFrom('game_participations')
    .select('id')
    .where('user_id', '=', userId)
    .where('active', '=', true)
    .executeTakeFirst();
  if (active) return true;
  const lobby = await trx
    .selectFrom('match_players as p')
    .innerJoin('matches as m', 'm.id', 'p.match_id')
    .select('m.id')
    .where('p.user_id', '=', userId)
    .where('m.status', '=', 'lobby')
    .executeTakeFirst();
  if (lobby) return true;
  const queued = await trx
    .selectFrom('matchmaking_queue')
    .select('user_id')
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return Boolean(queued);
}

async function lockUser(trx: Trx, userId: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`games:${userId}`}))`.execute(trx);
}

function shuffle<T>(xs: readonly T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ---------------------------------------------------------------------------------------------
// Starting a match
// ---------------------------------------------------------------------------------------------

/**
 * A poll every participant may play: latest snapshot eligible, still a live survey, and for each
 * player either never played or replay-eligible (§7, §23.2). Chosen by the server at random.
 */
async function pickSharedPoll(trx: Trx, userIds: readonly string[], now: Date) {
  const latest = await sql<{
    id: string;
    poll_id: string;
    respondents: number;
    distribution: Record<string, number>;
    eligible: boolean;
  }>`
    SELECT DISTINCT ON (s.poll_id) s.id, s.poll_id, s.respondents, s.distribution, s.eligible
    FROM result_snapshots s JOIN polls p ON p.id = s.poll_id
    WHERE p.status = 'survey'
    ORDER BY s.poll_id, s.version DESC
  `.execute(trx);
  const played = await trx
    .selectFrom('played_polls as pp')
    .innerJoin('result_snapshots as s', 's.id', 'pp.last_snapshot_id')
    .select(['pp.user_id', 'pp.poll_id', 'pp.last_played_at', 's.respondents', 's.distribution'])
    .where('pp.user_id', 'in', userIds)
    .execute();
  const open = latest.rows.filter(
    (c) =>
      c.eligible &&
      played
        .filter((p) => p.poll_id === c.poll_id)
        .every((p) =>
          replayEligible({
            lastPlayedAt: p.last_played_at,
            previous: { respondents: p.respondents, distribution: p.distribution },
            current: { respondents: c.respondents, distribution: c.distribution },
            now,
          }),
        ),
  );
  return open.length ? open[randomInt(open.length)]! : null;
}

/**
 * Starts a match for fixed sides (arrays of user ids). Reserves one daily game per player
 * (no charge yet), freezes one snapshot for everyone, and starts the server clock.
 */
async function startMatch(
  trx: Trx,
  match: { id: string; format: MatchFormat },
  sides: readonly (readonly string[])[],
  now: Date,
  pending: Pending,
) {
  const everyone = sides.flat();
  for (const u of everyone) {
    if ((await chargedOn(trx, u, etDate(now))) >= DAILY_GAME_LIMIT) throw unavailable();
  }
  const snap = await pickSharedPoll(trx, everyone, now);
  if (!snap) throw noSharedPoll();

  for (const u of everyone) {
    try {
      const part = await trx
        .insertInto('game_participations')
        .values({ match_id: match.id, game_id: null, user_id: u, created_at: now })
        .returning('id')
        .executeTakeFirstOrThrow();
      await reserve(trx, u, part.id, now);
    } catch (err) {
      if (isUniqueViolation(err, 'game_participations_one_active')) throw unavailable();
      throw err;
    }
  }

  const sideIds: string[] = [];
  for (const [i, members] of sides.entries()) {
    const side = await trx
      .insertInto('match_sides')
      .values({ match_id: match.id, side_index: i, rotation: JSON.stringify(shuffle(members)) })
      .returning('id')
      .executeTakeFirstOrThrow();
    sideIds.push(side.id);
    await trx
      .updateTable('match_players')
      .set({ side_id: side.id })
      .where('match_id', '=', match.id)
      .where('user_id', 'in', [...members])
      .execute();
  }

  await trx
    .updateTable('matches')
    .set({
      status: 'active',
      poll_id: snap.poll_id,
      snapshot_id: snap.id,
      started_at: now,
      ends_at: new Date(now.getTime() + MATCH_DURATION_MS[match.format]),
      turn_order: match.format === 'classic' ? JSON.stringify(shuffle(sideIds)) : null,
      turn_index: match.format === 'classic' ? 0 : null,
      turn_started_at: match.format === 'classic' ? now : null,
    })
    .where('id', '=', match.id)
    .execute();
  await audit(trx, {
    actor: null,
    action: 'match.start',
    targetType: 'match',
    targetId: match.id,
    detail: { players: everyone.length },
  });
  for (const u of everyone) pending.users.set(u, { type: 'match.started', matchId: match.id });
  await bump(trx, match.id, pending);
}

// ---------------------------------------------------------------------------------------------
// Private rooms
// ---------------------------------------------------------------------------------------------

export async function createRoom(
  deps: AppDeps,
  userId: string,
  input: { mode: MatchMode; format: MatchFormat },
) {
  const now = deps.clock();
  const matchId = await deps.db.transaction().execute(async (trx) => {
    await lockUser(trx, userId);
    if (await isBusy(trx, userId)) throw busy();
    for (let attempt = 0; ; attempt++) {
      const code = Array.from(
        { length: 6 },
        () => ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)],
      ).join('');
      try {
        const m = await trx
          .insertInto('matches')
          .values({
            ...input,
            source: 'private',
            room_code: code,
            host_user_id: userId,
            created_at: now,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('match_players')
          .values({
            match_id: m.id,
            user_id: userId,
            preferred_team: null,
            side_id: null,
            joined_at: now,
          })
          .execute();
        return m.id;
      } catch (err) {
        if (!isUniqueViolation(err, 'matches_room_code_key') || attempt > 5) throw err;
      }
    }
  });
  return getMatchView(deps, userId, matchId);
}

export async function joinRoom(deps: AppDeps, userId: string, code: string) {
  const now = deps.clock();
  const pending = new Pending();
  const matchId = await deps.db.transaction().execute(async (trx) => {
    await lockUser(trx, userId);
    const m = await trx
      .selectFrom('matches')
      .selectAll()
      .where('room_code', '=', code.toUpperCase().replace(/[\s-]/g, ''))
      .forUpdate()
      .executeTakeFirst();
    if (!m || m.status !== 'lobby')
      throw new AppError(404, 'ROOM_NOT_FOUND', 'That room code is not open');
    const already = await trx
      .selectFrom('match_players')
      .select('user_id')
      .where('match_id', '=', m.id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (already) return m.id;
    if (await isBusy(trx, userId)) throw busy();
    const count = await trx
      .selectFrom('match_players')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('match_id', '=', m.id)
      .executeTakeFirstOrThrow();
    if (Number(count.n) >= MODE_MAX[m.mode])
      throw new AppError(409, 'ROOM_FULL', 'This room is full');
    await trx
      .insertInto('match_players')
      .values({
        match_id: m.id,
        user_id: userId,
        preferred_team: null,
        side_id: null,
        joined_at: now,
      })
      .execute();
    await bump(trx, m.id, pending);
    return m.id;
  });
  pending.flush(deps);
  return getMatchView(deps, userId, matchId);
}

const MODE_MAX: Record<MatchMode, number> = { h2h: 2, teams: 4, ffa: 6 };

export async function chooseTeam(deps: AppDeps, userId: string, matchId: string, team: 0 | 1) {
  const pending = new Pending();
  await deps.db.transaction().execute(async (trx) => {
    const m = await loadMatch(trx, matchId, true);
    await requirePlayer(trx, matchId, userId);
    if (m.status !== 'lobby' || m.mode !== 'teams')
      throw new AppError(409, 'NOT_A_TEAMS_LOBBY', 'Teams can only be chosen in a Teams lobby');
    const onTeam = await trx
      .selectFrom('match_players')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('match_id', '=', matchId)
      .where('preferred_team', '=', team)
      .where('user_id', '!=', userId)
      .executeTakeFirstOrThrow();
    if (Number(onTeam.n) >= 2)
      throw new AppError(409, 'TEAM_FULL', 'That team already has 2 players');
    await trx
      .updateTable('match_players')
      .set({ preferred_team: team })
      .where('match_id', '=', matchId)
      .where('user_id', '=', userId)
      .execute();
    await bump(trx, matchId, pending);
  });
  pending.flush(deps);
  return getMatchView(deps, userId, matchId);
}

export async function leaveLobby(deps: AppDeps, userId: string, matchId: string) {
  const pending = new Pending();
  await deps.db.transaction().execute(async (trx) => {
    const m = await loadMatch(trx, matchId, true);
    await requirePlayer(trx, matchId, userId);
    if (m.status !== 'lobby')
      throw new AppError(409, 'MATCH_STARTED', 'The match has already started');
    await trx
      .deleteFrom('match_players')
      .where('match_id', '=', matchId)
      .where('user_id', '=', userId)
      .execute();
    const next = await trx
      .selectFrom('match_players')
      .select('user_id')
      .where('match_id', '=', matchId)
      .orderBy('joined_at')
      .executeTakeFirst();
    if (!next)
      await trx
        .updateTable('matches')
        .set({ status: 'closed', host_user_id: null })
        .where('id', '=', matchId)
        .execute();
    else if (m.host_user_id === userId)
      await trx
        .updateTable('matches')
        .set({ host_user_id: next.user_id })
        .where('id', '=', matchId)
        .execute();
    await bump(trx, matchId, pending);
  });
  pending.flush(deps);
  return { left: true };
}

/** Host starts a private room once it has a valid number of players (update §1). */
export async function startRoom(deps: AppDeps, userId: string, matchId: string) {
  const now = deps.clock();
  const pending = new Pending();
  await deps.db.transaction().execute(async (trx) => {
    const m = await loadMatch(trx, matchId, true);
    await requirePlayer(trx, matchId, userId);
    if (m.status !== 'lobby')
      throw new AppError(409, 'MATCH_STARTED', 'The match has already started');
    if (m.host_user_id !== userId)
      throw new AppError(403, 'HOST_ONLY', 'Only the host can start the match');
    const players = await trx
      .selectFrom('match_players')
      .select(['user_id', 'preferred_team'])
      .where('match_id', '=', matchId)
      .orderBy('joined_at')
      .execute();
    if (!validPlayerCount(m.mode, players.length)) {
      throw new AppError(
        409,
        'WRONG_PLAYER_COUNT',
        'Head-to-Head needs 2 players, Teams needs 4, Free-for-All needs 3 to 6',
      );
    }
    let sides: string[][];
    if (m.mode === 'teams') {
      const t: [string[], string[]] = [[], []];
      for (const p of players)
        if (p.preferred_team !== null) t[p.preferred_team as 0 | 1].push(p.user_id);
      for (const p of shuffle(players.filter((x) => x.preferred_team === null)))
        (t[0].length < 2 ? t[0] : t[1]).push(p.user_id);
      sides = t;
    } else {
      sides = players.map((p) => [p.user_id]);
    }
    await startMatch(trx, { id: matchId, format: m.format }, sides, now, pending);
  });
  pending.flush(deps);
  return getMatchView(deps, userId, matchId);
}

// ---------------------------------------------------------------------------------------------
// Public matchmaking: first available compatible players (§7)
// ---------------------------------------------------------------------------------------------

export async function enqueue(
  deps: AppDeps,
  userId: string,
  input: { mode: MatchMode; format: MatchFormat },
) {
  const now = deps.clock();
  await deps.db.transaction().execute(async (trx) => {
    await lockUser(trx, userId);
    if (await isBusy(trx, userId)) throw busy();
    if ((await chargedOn(trx, userId, etDate(now))) >= DAILY_GAME_LIMIT) {
      throw new AppError(
        409,
        'DAILY_LIMIT_REACHED',
        "You've used all 10 guessing games for today. They reset at 12:00 AM Eastern Time.",
      );
    }
    await trx
      .insertInto('matchmaking_queue')
      .values({ user_id: userId, ...input, enqueued_at: now })
      .execute();
  });
  await runMatcher(deps, input.mode, input.format);
  return queueStatus(deps, userId);
}

export async function cancelQueue(deps: AppDeps, userId: string) {
  await deps.db.deleteFrom('matchmaking_queue').where('user_id', '=', userId).execute();
  return { queued: false };
}

export async function queueStatus(deps: AppDeps, userId: string) {
  const q = await deps.db
    .selectFrom('matchmaking_queue')
    .select(['mode', 'format', 'enqueued_at'])
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (q) return { queued: true, mode: q.mode, format: q.format, since: q.enqueued_at };
  return { queued: false, matchId: (await currentMatchId(deps, userId)) ?? null };
}

/** Forms as many matches as possible from the front of one queue. Safe to run concurrently. */
export async function runMatcher(
  deps: AppDeps,
  mode: MatchMode,
  format: MatchFormat,
): Promise<number> {
  let made = 0;
  for (;;) {
    const pending = new Pending();
    const formed = await deps.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`matchmaking:${mode}:${format}`}))`.execute(
        trx,
      );
      const now = deps.clock();
      const queue = await trx
        .selectFrom('matchmaking_queue')
        .select('user_id')
        .where('mode', '=', mode)
        .where('format', '=', format)
        .orderBy('enqueued_at')
        .orderBy('user_id')
        .execute();
      const need = mode === 'ffa' ? Math.min(MODE_MAX.ffa, queue.length) : MODE_MAX[mode];
      if (queue.length < Math.max(need, mode === 'ffa' ? 3 : need)) return false;
      const group = queue.slice(0, need).map((q) => q.user_id);
      const m = await trx
        .insertInto('matches')
        .values({
          mode,
          format,
          source: 'public',
          room_code: null,
          host_user_id: null,
          created_at: now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('match_players')
        .values(
          group.map((u) => ({
            match_id: m.id,
            user_id: u,
            preferred_team: null,
            side_id: null,
            joined_at: now,
          })),
        )
        .execute();
      const sides =
        mode === 'teams'
          ? (() => {
              const s = shuffle(group);
              return [s.slice(0, 2), s.slice(2, 4)];
            })()
          : group.map((u) => [u]);
      try {
        await sql`SAVEPOINT start_match`.execute(trx);
        await startMatch(trx, { id: m.id, format }, sides, now, pending);
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        await sql`ROLLBACK TO SAVEPOINT start_match`.execute(trx);
        // Couldn't start (no shared poll / someone unavailable): keep everyone queued.
        await trx.deleteFrom('match_players').where('match_id', '=', m.id).execute();
        await trx.updateTable('matches').set({ status: 'closed' }).where('id', '=', m.id).execute();
        return false;
      }
      await trx.deleteFrom('matchmaking_queue').where('user_id', 'in', group).execute();
      return true;
    });
    pending.flush(deps);
    if (!formed) return made;
    made++;
  }
}

// ---------------------------------------------------------------------------------------------
// Clocks, turns and the end of a match (server-authoritative)
// ---------------------------------------------------------------------------------------------

/**
 * Applies every time-based change up to `now`: Classic turns that timed out (the turn passes with
 * no strike and, in Teams, to the next teammate), and the end of the match clock. Deterministic.
 */
async function refresh(
  trx: Trx,
  deps: AppDeps,
  match: MatchRow,
  now: Date,
  pending: Pending,
): Promise<MatchRow> {
  if (match.status !== 'active') return match;
  const sides = await trx
    .selectFrom('match_sides')
    .selectAll()
    .where('match_id', '=', match.id)
    .execute();
  const finished = new Set(sides.filter((s) => s.finished).map((s) => s.id));
  const endsAt = match.ends_at!.getTime();
  const horizon = Math.min(now.getTime(), endsAt);

  if (match.format === 'classic' && match.turn_order && finished.size < sides.length) {
    let index = match.turn_index!;
    let startedAt = match.turn_started_at!.getTime();
    let changed = false;
    while (horizon >= startedAt + CLASSIC_TURN_MS && startedAt + CLASSIC_TURN_MS < endsAt) {
      const timedOut = match.turn_order[index]!;
      await trx
        .updateTable('match_sides')
        .set((eb) => ({ rotation_index: eb('rotation_index', '+', 1) }))
        .where('id', '=', timedOut)
        .execute();
      startedAt += CLASSIC_TURN_MS;
      index = nextUnfinished(match.turn_order, index, finished);
      changed = true;
    }
    if (changed) {
      await trx
        .updateTable('matches')
        .set({ turn_index: index, turn_started_at: new Date(startedAt) })
        .where('id', '=', match.id)
        .execute();
      await bump(trx, match.id, pending);
    }
  }

  if (now.getTime() >= endsAt || finished.size === sides.length) {
    await finalize(trx, match.id, new Date(Math.min(now.getTime(), endsAt)), pending);
  }
  return loadMatch(trx, match.id);
}

/** Ranks sides (update §3), records places and outcomes, ends every participation. */
async function finalize(trx: Trx, matchId: string, endedAt: Date, pending: Pending) {
  const m = await loadMatch(trx, matchId, true);
  if (m.status !== 'active') return;
  const snap = await trx
    .selectFrom('result_snapshots')
    .select('respondents')
    .where('id', '=', m.snapshot_id!)
    .executeTakeFirstOrThrow();
  const sides = await trx
    .selectFrom('match_sides')
    .selectAll()
    .where('match_id', '=', matchId)
    .execute();
  const groups = rankStandings(
    sides.map((s) => ({
      id: s.id,
      score: share(s.score_count, snap.respondents),
      reachedAt: s.reached_score_at ? s.reached_score_at.getTime() : null,
      correctCount: s.correct_count,
    })),
  );
  const place = placements(groups);
  const outcome = outcomes(groups);
  for (const s of sides) {
    await trx
      .updateTable('match_sides')
      .set({ placement: place.get(s.id)!, outcome: outcome.get(s.id)!, finished: true })
      .where('id', '=', s.id)
      .execute();
  }
  await trx
    .updateTable('matches')
    .set({ status: 'ended', ended_at: endedAt })
    .where('id', '=', matchId)
    .execute();

  const parts = await trx
    .selectFrom('game_participations')
    .select(['id', 'user_id'])
    .where('match_id', '=', matchId)
    .where('active', '=', true)
    .execute();
  for (const p of parts) await endParticipationRow(trx, p.id, p.user_id, endedAt);

  // Rarest Correct Guess credits the teammate who actually submitted the answer (update §8).
  const correct = await trx
    .selectFrom('match_guesses')
    .select(['id', 'submitted_by', 'share_count', 'share_total', 'at'])
    .where('match_id', '=', matchId)
    .where('result', '=', 'correct')
    .execute();
  const byUser = new Map<string, { guessId: string; count: number; total: number; at: Date }[]>();
  for (const c of correct) {
    const list = byUser.get(c.submitted_by) ?? [];
    list.push({ guessId: c.id, count: c.share_count!, total: c.share_total!, at: c.at });
    byUser.set(c.submitted_by, list);
  }
  for (const [u, list] of byUser) await recordRarest(trx, u, list, 'match');

  await audit(trx, { actor: null, action: 'match.end', targetType: 'match', targetId: matchId });
  for (const p of parts) pending.users.set(p.user_id, { type: 'match.ended', matchId });
  await bump(trx, matchId, pending);
}

/** Ends matches whose clock ran out. Run by a ticker so players see results without acting. */
export async function finishExpiredMatches(deps: AppDeps, now: Date): Promise<number> {
  const due = await deps.db
    .selectFrom('matches')
    .select('id')
    .where('status', '=', 'active')
    .where('ends_at', '<=', now)
    .execute();
  for (const d of due) {
    const pending = new Pending();
    await deps.db.transaction().execute(async (trx) => {
      const m = await loadMatch(trx, d.id, true);
      await refresh(trx, deps, m, now, pending);
    });
    pending.flush(deps);
  }
  return due.length;
}

// ---------------------------------------------------------------------------------------------
// Guessing
// ---------------------------------------------------------------------------------------------

async function sideBoard(
  trx: Trx,
  sideId: string,
  snap: { respondents: number; guess_cap: number | null; distribution: Record<string, number> },
) {
  const board = new GuessBoard({
    distribution: new Map(Object.entries(snap.distribution)),
    respondents: snap.respondents,
    guessCap: snap.guess_cap!,
    // Multiplayer: reaching 60% doesn't stop a side; highest final percentage wins (G4).
    stopAtTarget: false,
  });
  const prior = await trx
    .selectFrom('match_guesses')
    .select(['group_id', 'normalized_key', 'submitted_by', 'at'])
    .where('side_id', '=', sideId)
    .orderBy('ord')
    .execute();
  for (const p of prior)
    board.submit({
      groupId: p.group_id,
      key: p.normalized_key,
      by: p.submitted_by,
      at: p.at.getTime(),
    });
  return board;
}

export type MatchGuessResult =
  | { result: 'correct'; answer: string; percent: string }
  | { result: 'incorrect' }
  | { result: 'already_guessed' };

/**
 * One guess. Classic: only the side whose turn it is, and in Teams only the teammate whose turn it
 * is to submit; an accepted guess passes the turn. Speed: anyone, any time before the clock ends.
 * A team's first accepted guess charges every teammate one daily game and marks the poll played.
 */
export async function submitMatchGuess(
  deps: AppDeps,
  userId: string,
  matchId: string,
  text: string,
  clientRequestId: string,
) {
  const clean = cleanAnswer(text);
  if (!clean || clean.length > 80 || !/[\p{L}\p{N}]/u.test(clean))
    throw new AppError(422, 'INVALID_GUESS', 'Please type a guess');
  const now = deps.clock();
  const pending = new Pending();
  const result = await deps.db.transaction().execute(async (trx): Promise<MatchGuessResult> => {
    let m = await loadMatch(trx, matchId, true);
    const me = await requirePlayer(trx, matchId, userId);
    const snap = await trx
      .selectFrom('result_snapshots')
      .select(['respondents', 'guess_cap', 'distribution', 'keymap', 'labels'])
      .where('id', '=', m.snapshot_id ?? '00000000-0000-0000-0000-000000000000')
      .executeTakeFirst();
    const prior = await trx
      .selectFrom('match_guesses')
      .select(['result', 'group_id'])
      .where('match_id', '=', matchId)
      .where('submitted_by', '=', userId)
      .where('client_request_id', '=', clientRequestId)
      .executeTakeFirst();
    if (prior && snap) return view(prior.result, prior.group_id, snap);

    m = await refresh(trx, deps, m, now, pending);
    if (m.status !== 'active' || !snap)
      throw new AppError(409, 'MATCH_NOT_ACTIVE', 'This match is not in progress');
    const side = await trx
      .selectFrom('match_sides')
      .selectAll()
      .where('id', '=', me.side_id!)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (side.finished) throw new AppError(409, 'SIDE_FINISHED', 'Your side has no guesses left');
    if (m.format === 'classic') {
      if (m.turn_order![m.turn_index!] !== side.id)
        throw new AppError(409, 'NOT_YOUR_TURN', "It's not your turn");
      if (side.rotation[side.rotation_index % side.rotation.length] !== userId) {
        throw new AppError(409, 'NOT_YOUR_TURN', "It's your teammate's turn to guess");
      }
    }

    const board = await sideBoard(trx, side.id, snap);
    const match = matchGuess(clean, snap.keymap);
    const r = board.submit({
      groupId: match.groupId,
      key: match.key,
      by: userId,
      at: now.getTime(),
    });

    if (r.kind !== 'already_guessed' && side.accepted === 0) {
      const members = await trx
        .selectFrom('game_participations')
        .select(['id', 'user_id'])
        .where('match_id', '=', matchId)
        .where('user_id', 'in', side.rotation)
        .execute();
      for (const p of members) {
        const ok = await chargeParticipant(trx, {
          userId: p.user_id,
          participationId: p.id,
          pollId: m.poll_id!,
          snapshotId: m.snapshot_id!,
          now,
        });
        // Unreachable while the one-active-game rule holds; never accept an uncharged guess (§23.3).
        if (!ok)
          throw new AppError(
            409,
            'DAILY_LIMIT_REACHED',
            'A player on this side has no games left today',
          );
      }
    }

    await trx
      .insertInto('match_guesses')
      .values({
        match_id: matchId,
        side_id: side.id,
        submitted_by: userId,
        client_request_id: clientRequestId,
        seq: r.kind === 'already_guessed' ? null : board.accepted,
        normalized_key: match.key,
        group_id: match.groupId,
        result:
          r.kind === 'correct' ? 'correct' : r.kind === 'incorrect' ? 'incorrect' : 'duplicate',
        share_count: r.kind === 'correct' ? r.groupShare.count : null,
        share_total: r.kind === 'correct' ? r.groupShare.total : null,
        raw_text_enc: deps.crypto.encrypt(clean),
        at: now,
      })
      .execute();

    if (r.kind !== 'already_guessed') {
      await trx
        .updateTable('match_sides')
        .set({
          score_count: board.score().count,
          strikes: board.strikes,
          accepted: board.accepted,
          correct_count: board.correctCount,
          reached_score_at: board.reachedScoreAt === null ? null : new Date(board.reachedScoreAt),
          finished: board.finished,
          rotation_index: side.rotation_index + 1,
        })
        .where('id', '=', side.id)
        .execute();
      if (m.format === 'classic') {
        const all = await trx
          .selectFrom('match_sides')
          .select(['id', 'finished'])
          .where('match_id', '=', matchId)
          .execute();
        const finishedSet = new Set(all.filter((s) => s.finished).map((s) => s.id));
        await trx
          .updateTable('matches')
          .set({
            turn_index: nextUnfinished(m.turn_order!, m.turn_index!, finishedSet),
            turn_started_at: now,
          })
          .where('id', '=', matchId)
          .execute();
      }
      await bump(trx, matchId, pending);
      await refresh(trx, deps, await loadMatch(trx, matchId, true), now, pending);
    }
    return view(r.kind === 'already_guessed' ? 'duplicate' : r.kind, match.groupId, snap);
  });
  pending.flush(deps);
  return { ...result, match: await getMatchView(deps, userId, matchId) };
}

function view(
  result: 'correct' | 'incorrect' | 'duplicate',
  groupId: string | null,
  snap: {
    respondents: number;
    distribution: Record<string, number>;
    labels: Record<string, string>;
  },
): MatchGuessResult {
  if (result === 'duplicate') return { result: 'already_guessed' };
  if (result === 'incorrect' || !groupId) return { result: 'incorrect' };
  return {
    result: 'correct',
    answer: snap.labels[groupId]!,
    percent: formatPercent(share(snap.distribution[groupId]!, snap.respondents)),
  };
}

// ---------------------------------------------------------------------------------------------
// Views (per viewer). Opponents never see guessed words or answer names (update §2, spec §5, §7).
// ---------------------------------------------------------------------------------------------

export async function currentMatchId(deps: AppDeps, userId: string): Promise<string | null> {
  const active = await deps.db
    .selectFrom('game_participations')
    .select('match_id')
    .where('user_id', '=', userId)
    .where('active', '=', true)
    .where('match_id', 'is not', null)
    .executeTakeFirst();
  if (active?.match_id) return active.match_id;
  const lobby = await deps.db
    .selectFrom('match_players as p')
    .innerJoin('matches as m', 'm.id', 'p.match_id')
    .select('m.id')
    .where('p.user_id', '=', userId)
    .where('m.status', '=', 'lobby')
    .executeTakeFirst();
  return lobby?.id ?? null;
}

export async function getMatchView(deps: AppDeps, userId: string, matchId: string) {
  const now = deps.clock();
  const pending = new Pending();
  const out = await deps.db.transaction().execute(async (trx) => {
    let m = await loadMatch(trx, matchId, true);
    const me = await requirePlayer(trx, matchId, userId);
    m = await refresh(trx, deps, m, now, pending);
    const players = await trx
      .selectFrom('match_players as p')
      .innerJoin('profiles as pr', 'pr.user_id', 'p.user_id')
      .select(['p.user_id', 'p.side_id', 'p.preferred_team', 'pr.username'])
      .where('p.match_id', '=', matchId)
      .orderBy('p.joined_at')
      .execute();
    const name = new Map(players.map((p) => [p.user_id, p.username]));
    const base = {
      matchId: m.id,
      mode: m.mode,
      format: m.format,
      source: m.source,
      status: m.status,
    };

    if (m.status === 'lobby' || m.status === 'closed') {
      return {
        ...base,
        roomCode: m.room_code,
        host: m.host_user_id ? (name.get(m.host_user_id) ?? null) : null,
        isHost: m.host_user_id === userId,
        players: players.map((p) => ({ username: p.username, team: p.preferred_team })),
      };
    }

    const snap = await trx
      .selectFrom('result_snapshots')
      .select(['respondents', 'guess_cap', 'distribution', 'labels'])
      .where('id', '=', m.snapshot_id!)
      .executeTakeFirstOrThrow();
    const poll = await trx
      .selectFrom('polls')
      .select('text')
      .where('id', '=', m.poll_id!)
      .executeTakeFirstOrThrow();
    const sides = await trx
      .selectFrom('match_sides')
      .selectAll()
      .where('match_id', '=', matchId)
      .orderBy('side_index')
      .execute();
    const guesses = await trx
      .selectFrom('match_guesses')
      .selectAll()
      .where('match_id', '=', matchId)
      .orderBy('ord')
      .execute();
    const pct = (count: number) => formatPercent(share(count, snap.respondents));
    const currentSide =
      m.format === 'classic' && m.status === 'active' ? m.turn_order![m.turn_index!] : null;

    return {
      ...base,
      question: poll.text,
      clock: {
        startedAt: m.started_at,
        endsAt: m.ends_at,
        remainingMs: m.status === 'active' ? Math.max(0, m.ends_at!.getTime() - now.getTime()) : 0,
      },
      turn: currentSide
        ? (() => {
            const s = sides.find((x) => x.id === currentSide)!;
            const submitter = s.rotation[s.rotation_index % s.rotation.length]!;
            return {
              sideIndex: s.side_index,
              deadline: new Date(m.turn_started_at!.getTime() + CLASSIC_TURN_MS),
              player: name.get(submitter) ?? null,
              yours: submitter === userId,
            };
          })()
        : null,
      mySideIndex: sides.find((s) => s.id === me.side_id)?.side_index ?? null,
      maxStrikes: MAX_STRIKES,
      guessCap: snap.guess_cap,
      sides: sides.map((s) => {
        const mine = s.id === me.side_id;
        const sideGuesses = guesses.filter((g) => g.side_id === s.id);
        const contributions = s.rotation.map((u) => ({
          username: name.get(u) ?? null,
          percent: pct(
            sideGuesses
              .filter((g) => g.submitted_by === u && g.result === 'correct')
              .reduce((a, g) => a + g.share_count!, 0),
          ),
        }));
        return {
          sideIndex: s.side_index,
          players: s.rotation.map((u) => name.get(u) ?? null),
          score: pct(s.score_count),
          strikes: s.strikes,
          remaining: snap.guess_cap! - s.accepted,
          finished: s.finished,
          placement: s.placement,
          outcome: s.outcome,
          contributions,
          // Your own side sees its words and answers; other sides see only numbered results.
          guesses: mine
            ? sideGuesses.map((g) => ({
                number: g.seq,
                by: name.get(g.submitted_by) ?? null,
                text: deps.crypto.decrypt(g.raw_text_enc),
                result: g.result === 'duplicate' ? 'already_guessed' : g.result,
                ...(g.result === 'correct' && g.group_id
                  ? {
                      answer: snap.labels[g.group_id],
                      percent: pct(snap.distribution[g.group_id]!),
                    }
                  : {}),
              }))
            : sideGuesses
                .filter((g) => g.result !== 'duplicate')
                .map((g) => ({
                  number: g.seq,
                  result: g.result,
                  ...(g.result === 'correct' ? { percent: pct(g.share_count!) } : {}),
                })),
        };
      }),
    };
  });
  pending.flush(deps);
  return out;
}

export async function matchStats(deps: AppDeps, userId: string) {
  const rows = await deps.db
    .selectFrom('match_players as p')
    .innerJoin('matches as m', 'm.id', 'p.match_id')
    .innerJoin('match_sides as s', 's.id', 'p.side_id')
    .select(['m.mode', 'm.format', 's.outcome', 's.placement'])
    .where('p.user_id', '=', userId)
    .where('m.status', '=', 'ended')
    .where('m.valid', '=', true)
    .execute();
  const blank = () => ({ games: 0, wins: 0, losses: 0, draws: 0, first: 0, second: 0, third: 0 });
  const overall = blank();
  const byMode: Record<string, ReturnType<typeof blank>> = {};
  const byFormat: Record<string, ReturnType<typeof blank>> = {};
  for (const r of rows) {
    for (const b of [overall, (byMode[r.mode] ??= blank()), (byFormat[r.format] ??= blank())]) {
      b.games++;
      if (r.outcome === 'win') b.wins++;
      else if (r.outcome === 'loss') b.losses++;
      else if (r.outcome === 'draw') b.draws++;
      if (r.placement === 1) b.first++;
      else if (r.placement === 2) b.second++;
      else if (r.placement === 3) b.third++;
    }
  }
  const guesses = await deps.db
    .selectFrom('match_guesses as g')
    .innerJoin('matches as m', 'm.id', 'g.match_id')
    .select([
      (eb) => eb.fn.countAll<string>().filterWhere('g.result', '=', 'correct').as('correct'),
      (eb) => eb.fn.countAll<string>().filterWhere('g.result', '!=', 'duplicate').as('accepted'),
    ])
    .where('g.submitted_by', '=', userId)
    .where('m.status', '=', 'ended')
    .where('m.valid', '=', true)
    .executeTakeFirstOrThrow();
  return {
    ...overall,
    correctGuesses: Number(guesses.correct),
    acceptedGuesses: Number(guesses.accepted),
    byMode,
    byFormat,
  };
}
