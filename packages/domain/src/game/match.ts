/**
 * Multiplayer match rules (update §1–§3 with owner-approved G4, G5, G7).
 */
export type MatchMode = 'h2h' | 'teams' | 'ffa';
export type MatchFormat = 'classic' | 'speed';

/** Head-to-Head exactly 2; Teams exactly 4 (2 v 2); Free-for-All 3–6 (update §1). */
export const MODE_PLAYERS: Record<
  MatchMode,
  { min: number; max: number; sides: 'per_player' | 2 }
> = {
  h2h: { min: 2, max: 2, sides: 'per_player' },
  teams: { min: 4, max: 4, sides: 2 },
  ffa: { min: 3, max: 6, sides: 'per_player' },
};

/** Match-length clocks, not per-turn timers (update §1). */
export const MATCH_DURATION_MS: Record<MatchFormat, number> = { classic: 120_000, speed: 60_000 };

/** Classic turn limit (G5): if a side doesn't guess in time, the turn passes with no strike. */
export const CLASSIC_TURN_MS = 15_000;

export function validPlayerCount(mode: MatchMode, players: number): boolean {
  const r = MODE_PLAYERS[mode];
  return players >= r.min && players <= r.max;
}

export interface TurnState {
  /** side ids in turn order */
  order: readonly string[];
  index: number;
  startedAt: number;
}

/**
 * Advances Classic turns that timed out up to `now`, skipping sides that are finished.
 * Returns the turn in effect at `now` and how many turns passed by timeout.
 */
export function advanceTurns(
  t: TurnState,
  finished: ReadonlySet<string>,
  now: number,
  turnMs = CLASSIC_TURN_MS,
): TurnState & { timedOut: number } {
  let { index, startedAt } = t;
  let timedOut = 0;
  if (t.order.every((s) => finished.has(s))) return { order: t.order, index, startedAt, timedOut };
  while (now >= startedAt + turnMs) {
    startedAt += turnMs;
    index = nextUnfinished(t.order, index, finished);
    timedOut++;
  }
  if (finished.has(t.order[index]!)) index = nextUnfinished(t.order, index, finished);
  return { order: t.order, index, startedAt, timedOut };
}

/** Next side in order that is still playing (wraps around). */
export function nextUnfinished(
  order: readonly string[],
  index: number,
  finished: ReadonlySet<string>,
): number {
  for (let step = 1; step <= order.length; step++) {
    const i = (index + step) % order.length;
    if (!finished.has(order[i]!)) return i;
  }
  return index;
}

/**
 * Places from tie groups using standard competition numbering (G7): [[a],[b,c],[d]] -> a:1, b:2, c:2, d:4.
 */
export function placements(groups: readonly (readonly string[])[]): Map<string, number> {
  const out = new Map<string, number>();
  let place = 1;
  for (const g of groups) {
    for (const id of g) out.set(id, place);
    place += g.length;
  }
  return out;
}

export type MatchOutcome = 'win' | 'loss' | 'draw';

/**
 * Win/loss/draw per side (G7): the only side alone in 1st place wins; sides tied for 1st draw;
 * everyone else loses. Head-to-Head and Teams are the two-side case of the same rule.
 */
export function outcomes(groups: readonly (readonly string[])[]): Map<string, MatchOutcome> {
  const out = new Map<string, MatchOutcome>();
  groups.forEach((g, i) => {
    for (const id of g) out.set(id, i > 0 ? 'loss' : g.length === 1 ? 'win' : 'draw');
  });
  return out;
}
