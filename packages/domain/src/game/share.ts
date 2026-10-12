/**
 * Exact answer shares (spec update §3, §8, §9: "precise stored percentages, not rounded values").
 * A share is `count / total`: respondents in an answer group (or a side's summed groups) over the
 * frozen snapshot's respondents. Comparisons use integer cross-multiplication, never floats.
 */
export interface Share {
  readonly count: number;
  readonly total: number;
}

export function share(count: number, total: number): Share {
  if (
    !Number.isInteger(count) ||
    !Number.isInteger(total) ||
    total <= 0 ||
    count < 0 ||
    count > total
  ) {
    throw new RangeError('share requires integers with 0 <= count <= total and total > 0');
  }
  return { count, total };
}

/** -1 if a < b, 0 if equal, 1 if a > b — exact, across different totals. */
export function compareShares(a: Share, b: Share): -1 | 0 | 1 {
  const left = BigInt(a.count) * BigInt(b.total);
  const right = BigInt(b.count) * BigInt(a.total);
  return left < right ? -1 : left > right ? 1 : 0;
}

export const TARGET_PERCENT = 60;

/** True when the share is at least `percent`% (default: the 60% goal). */
export function meetsTarget(s: Share, percent = TARGET_PERCENT): boolean {
  return BigInt(s.count) * 100n >= BigInt(percent) * BigInt(s.total);
}

/** Display only. Rounds half up to `decimals` places using integer math. */
export function formatPercent(s: Share, decimals = 2): string {
  const scale = 10n ** BigInt(decimals);
  const scaled = (BigInt(s.count) * 100n * scale * 2n + BigInt(s.total)) / (BigInt(s.total) * 2n);
  const whole = scaled / scale;
  const frac = (scaled % scale).toString().padStart(decimals, '0');
  return decimals > 0 ? `${whole}.${frac}%` : `${whole}%`;
}
