/**
 * Replay eligibility for an already-played poll (spec §23.2). All three must hold:
 * 1. at least 30 days since the previous play;
 * 2. genuine respondents now >= 120% of the previous played snapshot;
 * 3. a material change: some top-five group (from either snapshot) moved by >= 5 percentage
 *    points, or the ordered top-three changed. Top-five membership change alone is not enough.
 */
export interface SnapshotView {
  respondents: number;
  /** answer group id -> respondents */
  distribution: Readonly<Record<string, number>>;
}

export const REPLAY_MIN_DAYS = 30;

/** Stable order: most respondents first, then group id. */
export function rankedGroups(s: SnapshotView): string[] {
  return Object.entries(s.distribution)
    .sort(([ga, a], [gb, b]) => b - a || (ga < gb ? -1 : ga > gb ? 1 : 0))
    .map(([g]) => g);
}

function shiftedAtLeastFivePoints(groupId: string, prev: SnapshotView, cur: SnapshotView): boolean {
  const p = BigInt(prev.distribution[groupId] ?? 0);
  const c = BigInt(cur.distribution[groupId] ?? 0);
  const tp = BigInt(prev.respondents);
  const tc = BigInt(cur.respondents);
  // |c/tc - p/tp| >= 5/100  <=>  |c*tp - p*tc| * 100 >= 5 * tp * tc
  const diff = c * tp - p * tc;
  const abs = diff < 0n ? -diff : diff;
  return abs * 100n >= 5n * tp * tc;
}

export function materialChange(prev: SnapshotView, cur: SnapshotView): boolean {
  const prevRank = rankedGroups(prev);
  const curRank = rankedGroups(cur);
  const topFive = new Set([...prevRank.slice(0, 5), ...curRank.slice(0, 5)]);
  if ([...topFive].some((g) => shiftedAtLeastFivePoints(g, prev, cur))) return true;
  return prevRank.slice(0, 3).join('|') !== curRank.slice(0, 3).join('|');
}

export function replayEligible(input: {
  lastPlayedAt: Date;
  previous: SnapshotView;
  current: SnapshotView;
  now: Date;
}): boolean {
  const days = (input.now.getTime() - input.lastPlayedAt.getTime()) / 86_400_000;
  if (days < REPLAY_MIN_DAYS) return false;
  if (input.current.respondents * 100 < input.previous.respondents * 120) return false;
  return materialChange(input.previous, input.current);
}
