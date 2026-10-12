import type { Database } from '@pplpoll/db';
import {
  cleanAnswer,
  etDate,
  formatPercent,
  GuessBoard,
  matchGuess,
  MAX_STRIKES,
  achievableObjectives,
  describeObjective,
  objectiveStatus,
  replayEligible,
  share,
  TARGET_PERCENT,
  type Objective,
} from '@pplpoll/domain';
import { sql, type Transaction } from 'kysely';
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

export { DAILY_GAME_LIMIT };

type Trx = Transaction<Database>;

const dailyLimit = () =>
  new AppError(
    409,
    'DAILY_LIMIT_REACHED',
    "You've used all 10 guessing games for today. They reset at 12:00 AM Eastern Time.",
  );
const noPoll = () =>
  new AppError(
    409,
    'NO_ELIGIBLE_POLL',
    "There's no new poll for you to play right now. Check back after more people answer.",
  );

type SnapshotRow = {
  id: string;
  eligible?: boolean;
  poll_id: string;
  respondents: number;
  k: number | null;
  guess_cap: number | null;
  distribution: Record<string, number>;
  keymap: Record<string, string>;
  labels: Record<string, string>;
};

/**
 * Picks a game-eligible poll at random: latest snapshot eligible, poll still live as a survey,
 * and never played by this person — or played but replay-eligible (§5, §6, §23.2).
 * Poll choice is always the server's; there is no browsing or picking.
 */
async function pickPoll(trx: Trx, userId: string, now: Date): Promise<SnapshotRow | null> {
  const latest = await sql<SnapshotRow>`
    SELECT DISTINCT ON (s.poll_id) s.id, s.poll_id, s.respondents, s.k, s.guess_cap, s.distribution, s.keymap, s.labels, s.eligible
    FROM result_snapshots s JOIN polls p ON p.id = s.poll_id
    WHERE p.status = 'survey'
    ORDER BY s.poll_id, s.version DESC
  `.execute(trx);
  const candidates = latest.rows.filter((r) => r.eligible);
  if (candidates.length === 0) return null;
  const played = await trx
    .selectFrom('played_polls as pp')
    .innerJoin('result_snapshots as s', 's.id', 'pp.last_snapshot_id')
    .select(['pp.poll_id', 'pp.last_played_at', 's.respondents', 's.distribution'])
    .where('pp.user_id', '=', userId)
    .execute();
  const playedBy = new Map(played.map((p) => [p.poll_id, p]));
  const open = candidates.filter((c) => {
    const p = playedBy.get(c.poll_id);
    if (!p) return true;
    return replayEligible({
      lastPlayedAt: p.last_played_at,
      previous: { respondents: p.respondents, distribution: p.distribution },
      current: { respondents: c.respondents, distribution: c.distribution },
      now,
    });
  });
  if (open.length === 0) return null;
  return open[Math.floor(Math.random() * open.length)]!;
}

export type SoloMode = 'solo' | 'mystery';

export const startSolo = (deps: AppDeps, userId: string) => startGame(deps, userId, 'solo');

/** Mystery Challenge (update §6): a random unplayed poll with one achievable special objective. */
export const startMystery = (deps: AppDeps, userId: string) => startGame(deps, userId, 'mystery');

function pickObjective(snap: SnapshotRow): Objective {
  const options = achievableObjectives({
    respondents: snap.respondents,
    distribution: snap.distribution,
    k: snap.k!,
    guessCap: snap.guess_cap!,
  });
  return options[Math.floor(Math.random() * options.length)]!;
}

async function startGame(deps: AppDeps, userId: string, mode: SoloMode) {
  const now = deps.clock();
  const date = etDate(now);
  try {
    const gameId = await deps.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`games:${userId}`}))`.execute(trx);
      const active = await trx
        .selectFrom('game_participations')
        .select('game_id')
        .where('user_id', '=', userId)
        .where('active', '=', true)
        .executeTakeFirst();
      if (active)
        throw new AppError(409, 'ACTIVE_GAME_EXISTS', 'Finish your current game first', {
          gameId: active.game_id,
        });
      if ((await chargedOn(trx, userId, date)) >= DAILY_GAME_LIMIT) throw dailyLimit();
      const snap = await pickPoll(trx, userId, now);
      if (!snap) throw noPoll();
      const game = await trx
        .insertInto('games')
        .values({
          mode,
          objective: mode === 'mystery' ? JSON.stringify(pickObjective(snap)) : null,
          poll_id: snap.poll_id,
          snapshot_id: snap.id,
          user_id: userId,
          score_total: snap.respondents,
          guess_cap: snap.guess_cap!,
          created_at: now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const part = await trx
        .insertInto('game_participations')
        .values({ game_id: game.id, user_id: userId, created_at: now })
        .returning('id')
        .executeTakeFirstOrThrow();
      // Reserving does not charge; the first accepted guess does (§23.3).
      await reserve(trx, userId, part.id, now);
      return game.id;
    });
    return getGame(deps, userId, gameId);
  } catch (err) {
    if (isUniqueViolation(err, 'game_participations_one_active')) {
      throw new AppError(409, 'ACTIVE_GAME_EXISTS', 'Finish your current game first');
    }
    throw err;
  }
}

async function loadGame(trx: Trx, userId: string, gameId: string, lock: boolean) {
  let q = trx
    .selectFrom('games')
    .selectAll()
    .where('id', '=', gameId)
    .where('user_id', '=', userId);
  if (lock) q = q.forUpdate();
  const g = await q.executeTakeFirst();
  if (!g) throw errors.notFound();
  return g;
}

async function rebuildBoard(trx: Trx, gameId: string, snap: SnapshotRow, mode: SoloMode) {
  const board = new GuessBoard({
    distribution: new Map(Object.entries(snap.distribution)),
    respondents: snap.respondents,
    guessCap: snap.guess_cap!,
    // Solo stops at 60%; a Mystery Challenge ends on its own objective instead.
    stopAtTarget: mode === 'solo',
  });
  const prior = await trx
    .selectFrom('guesses')
    .select(['group_id', 'normalized_key', 'submitted_by', 'at'])
    .where('game_id', '=', gameId)
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

async function snapshotOf(trx: Trx, id: string): Promise<SnapshotRow> {
  return trx
    .selectFrom('result_snapshots')
    .select(['id', 'poll_id', 'respondents', 'k', 'guess_cap', 'distribution', 'keymap', 'labels'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

async function endParticipation(
  trx: Trx,
  gameId: string,
  userId: string,
  outcome: 'won' | 'lost' | 'released',
  now: Date,
) {
  await trx
    .updateTable('games')
    .set({ state: 'ended', outcome, ended_at: now })
    .where('id', '=', gameId)
    .execute();
  const part = await trx
    .selectFrom('game_participations')
    .select('id')
    .where('game_id', '=', gameId)
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
  await endParticipationRow(trx, part.id, userId, now);
  if (outcome === 'won' || outcome === 'lost') {
    const correct = await trx
      .selectFrom('guesses')
      .select(['id', 'share_count', 'share_total', 'at'])
      .where('game_id', '=', gameId)
      .where('result', '=', 'correct')
      .execute();
    await recordRarest(
      trx,
      userId,
      correct.map((c) => ({
        guessId: c.id,
        count: c.share_count!,
        total: c.share_total!,
        at: c.at,
      })),
      'game',
    );
  }
}

export type GuessResultView =
  | { result: 'correct'; answer: string; percent: string }
  | { result: 'incorrect' }
  | { result: 'already_guessed' };

/**
 * One guess in a solo game (§5, §6). Retrying with the same clientRequestId returns the same result.
 * Repeats are neutral. Wrong guesses cost an attempt and a strike.
 */
export async function submitGuess(
  deps: AppDeps,
  userId: string,
  gameId: string,
  text: string,
  clientRequestId: string,
) {
  const now = deps.clock();
  const clean = cleanAnswer(text);
  if (!clean || clean.length > 80 || !/[\p{L}\p{N}]/u.test(clean)) {
    throw new AppError(422, 'INVALID_GUESS', 'Please type a guess');
  }
  const outcome = await deps.db
    .transaction()
    .execute(
      async (trx): Promise<{ released: true } | { released: false; view: GuessResultView }> => {
        const game = await loadGame(trx, userId, gameId, true);
        const prior = await trx
          .selectFrom('guesses')
          .select(['result', 'group_id'])
          .where('game_id', '=', gameId)
          .where('client_request_id', '=', clientRequestId)
          .executeTakeFirst();
        const snap = await snapshotOf(trx, game.snapshot_id);
        if (prior) return { released: false, view: toView(prior.result, prior.group_id, snap) };
        if (game.state !== 'active') throw new AppError(409, 'GAME_OVER', 'This game has ended');

        const board = await rebuildBoard(trx, gameId, snap, game.mode);
        const match = matchGuess(clean, snap.keymap);
        const r = board.submit({
          groupId: match.groupId,
          key: match.key,
          by: userId,
          at: now.getTime(),
        });
        const part = await trx
          .selectFrom('game_participations')
          .select(['id', 'first_guess_at'])
          .where('game_id', '=', gameId)
          .where('user_id', '=', userId)
          .executeTakeFirstOrThrow();

        if (r.kind !== 'already_guessed' && !part.first_guess_at) {
          if (
            !(await chargeParticipant(trx, {
              userId,
              participationId: part.id,
              pollId: game.poll_id,
              snapshotId: game.snapshot_id,
              now,
            }))
          ) {
            // New day already full: never accept an uncharged guess (§23.3). Release safely instead.
            await endParticipation(trx, gameId, userId, 'released', now);
            return { released: true };
          }
        }

        await trx
          .insertInto('guesses')
          .values({
            game_id: gameId,
            participation_id: part.id,
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
            .updateTable('games')
            .set({
              score_count: board.score().count,
              strikes: board.strikes,
              accepted: board.accepted,
              correct_count: board.correctCount,
              reached_score_at:
                board.reachedScoreAt === null ? null : new Date(board.reachedScoreAt),
            })
            .where('id', '=', gameId)
            .execute();
          const result = gameResult(game.mode, game.objective as Objective | null, board);
          if (result) {
            await endParticipation(trx, gameId, userId, result, now);
            await audit(trx, {
              actor: userId,
              action: 'game.end',
              targetType: 'game',
              targetId: gameId,
              detail: { outcome: result, mode: game.mode },
            });
          }
        }
        return {
          released: false,
          view: toView(r.kind === 'already_guessed' ? 'duplicate' : r.kind, match.groupId, snap),
        };
      },
    );
  if (outcome.released) throw dailyLimit();
  return { ...outcome.view, game: await getGame(deps, userId, gameId) };
}

/** Solo: 60% wins, strikes/cap lose. Mystery: the objective decides; strikes/cap still end it. */
function gameResult(
  mode: SoloMode,
  objective: Objective | null,
  board: GuessBoard,
): 'won' | 'lost' | null {
  if (mode === 'solo')
    return board.finished ? (board.finishedReason === 'target' ? 'won' : 'lost') : null;
  const status = objectiveStatus(objective!, {
    found: board.foundGroups(),
    score: board.score(),
    strikes: board.strikes,
    accepted: board.accepted,
  });
  if (status === 'completed') return 'won';
  if (status === 'failed' || board.finished) return 'lost';
  return null;
}

function toView(
  result: 'correct' | 'incorrect' | 'duplicate',
  groupId: string | null,
  snap: SnapshotRow,
): GuessResultView {
  if (result === 'duplicate') return { result: 'already_guessed' };
  if (result === 'incorrect' || !groupId) return { result: 'incorrect' };
  return {
    result: 'correct',
    answer: snap.labels[groupId]!,
    percent: formatPercent(share(snap.distribution[groupId]!, snap.respondents)),
  };
}

/**
 * What the player sees: the question, their found answers with percentages, total, strikes,
 * remaining attempts and outcome. Never the full answer list — not even after a loss (§5).
 */
export async function getGame(deps: AppDeps, userId: string, gameId: string) {
  return deps.db.transaction().execute(async (trx) => {
    const game = await loadGame(trx, userId, gameId, false);
    const snap = await snapshotOf(trx, game.snapshot_id);
    const poll = await trx
      .selectFrom('polls')
      .select('text')
      .where('id', '=', game.poll_id)
      .executeTakeFirstOrThrow();
    const guesses = await trx
      .selectFrom('guesses')
      .select(['result', 'group_id', 'raw_text_enc', 'seq'])
      .where('game_id', '=', gameId)
      .orderBy('ord')
      .execute();
    return {
      gameId: game.id,
      mode: game.mode,
      question: poll.text,
      state: game.state,
      outcome: game.outcome,
      targetPercent: game.mode === 'solo' ? TARGET_PERCENT : null,
      objective: game.objective
        ? {
            type: (game.objective as Objective).type,
            description: describeObjective(game.objective as Objective),
          }
        : null,
      score: formatPercent(share(game.score_count, game.score_total)),
      strikes: game.strikes,
      maxStrikes: MAX_STRIKES,
      guessCap: game.guess_cap,
      remaining: game.guess_cap - game.accepted,
      found: guesses
        .filter((g) => g.result === 'correct' && g.group_id)
        .map((g) => ({
          answer: snap.labels[g.group_id!]!,
          percent: formatPercent(share(snap.distribution[g.group_id!]!, snap.respondents)),
        })),
      // The player's own guesses, including their words (only ever shown to them).
      myGuesses: guesses.map((g) => ({
        number: g.seq,
        text: deps.crypto.decrypt(g.raw_text_enc),
        result: g.result === 'duplicate' ? 'already_guessed' : g.result,
      })),
    };
  });
}

export async function guessingStatus(deps: AppDeps, userId: string) {
  const date = etDate(deps.clock());
  const used = await chargedOn(deps.db, userId, date);
  const active = await deps.db
    .selectFrom('game_participations')
    .select('game_id')
    .where('user_id', '=', userId)
    .where('active', '=', true)
    .executeTakeFirst();
  return {
    etDate: date,
    gamesUsed: used,
    gamesLeft: DAILY_GAME_LIMIT - used,
    activeGameId: active?.game_id ?? null,
  };
}
