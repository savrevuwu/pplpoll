/**
 * Rarest Correct Guess (update §8) and the sitewide record-holder badge (update §9).
 * Shares are the frozen-snapshot share at game time and are compared exactly.
 */
import { compareShares, type Share } from './share.js';

/** True when `candidate` is strictly rarer than the current personal record. */
export function isRarer(candidate: Share, current: Share | null): boolean {
  return current === null || compareShares(candidate, current) < 0;
}

export interface PersonalBest {
  userId: string;
  share: Share;
}

/** Everyone tied at the lowest share holds the badge; null when nobody has a correct guess yet. */
export function recordHolders(
  bests: readonly PersonalBest[],
): { share: Share; userIds: string[] } | null {
  let best: Share | null = null;
  let holders: string[] = [];
  for (const b of bests) {
    const c = best === null ? -1 : compareShares(b.share, best);
    if (c < 0) {
      best = b.share;
      holders = [b.userId];
    } else if (c === 0) {
      holders.push(b.userId);
    }
  }
  return best === null ? null : { share: best, userIds: holders.sort() };
}
