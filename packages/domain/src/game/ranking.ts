/**
 * Winners and tiebreakers, identical for Head-to-Head, Teams and Free-for-All (update §3):
 * 1. higher final share; 2. earlier time that final share was reached;
 * 3. fewer correct guesses; 4. otherwise a genuine tie.
 */
import { compareShares, type Share } from './share.js';

export interface Standing {
  id: string;
  score: Share;
  /** server time the final score was reached; null when the score is 0 */
  reachedAt: number | null;
  correctCount: number;
}

/** Negative when `a` ranks ahead of `b`, positive when behind, 0 for a genuine tie. */
export function compareStandings(a: Standing, b: Standing): number {
  const byScore = compareShares(b.score, a.score);
  if (byScore !== 0) return byScore;
  if (a.reachedAt !== b.reachedAt) {
    if (a.reachedAt === null) return 1;
    if (b.reachedAt === null) return -1;
    return a.reachedAt < b.reachedAt ? -1 : 1;
  }
  if (a.correctCount !== b.correctCount) return a.correctCount < b.correctCount ? -1 : 1;
  return 0;
}

/**
 * Orders competitors into tie groups, best first: e.g. [[x], [y, z], [w]].
 * How tied places are numbered and counted as wins is pending owner decision G7.
 */
export function rankStandings(standings: readonly Standing[]): string[][] {
  const sorted = [...standings].sort(compareStandings);
  const groups: string[][] = [];
  let prev: Standing | undefined;
  for (const s of sorted) {
    if (prev && compareStandings(prev, s) === 0) groups.at(-1)!.push(s.id);
    else groups.push([s.id]);
    prev = s;
  }
  return groups;
}

export type DuelOutcome = 'a' | 'b' | 'draw';

/** Head-to-Head or Teams result between two sides. */
export function duelOutcome(a: Standing, b: Standing): DuelOutcome {
  const c = compareStandings(a, b);
  return c < 0 ? 'a' : c > 0 ? 'b' : 'draw';
}
