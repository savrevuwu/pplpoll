// Spec §5, §23.1 and update §3/§8: exact shares, K, guess cap, gameplay gate.
import { describe, expect, it } from 'vitest';
import {
  compareShares,
  computeK,
  formatPercent,
  gameEligibility,
  guessCap,
  meetsTarget,
  share,
} from '../src/index.js';

describe('exact shares', () => {
  it('compare exactly across different totals', () => {
    expect(compareShares(share(1, 3), share(333, 1000))).toBe(1); // 33.33..% > 33.3%
    expect(compareShares(share(2, 6), share(1, 3))).toBe(0);
    expect(compareShares(share(1, 120), share(1, 119))).toBe(-1);
  });
  it('do not fall for float rounding', () => {
    // 0.1 + 0.2 style traps: 1/10 + 2/10 vs 3/10 as exact counts.
    expect(compareShares(share(1 + 2, 10), share(3, 10))).toBe(0);
    expect(compareShares(share(999_999_999, 1_000_000_000), share(999_999_998, 999_999_999))).toBe(
      1,
    );
  });
  it('60% target uses exact integers', () => {
    expect(meetsTarget(share(60, 100))).toBe(true);
    expect(meetsTarget(share(59, 100))).toBe(false);
    expect(meetsTarget(share(3, 5))).toBe(true);
    expect(meetsTarget(share(599, 1000))).toBe(false);
  });
  it('formats for display only', () => {
    expect(formatPercent(share(1, 3))).toBe('33.33%');
    expect(formatPercent(share(2, 3))).toBe('66.67%');
    expect(formatPercent(share(1, 119))).toBe('0.84%');
    expect(formatPercent(share(1, 8), 1)).toBe('12.5%');
  });
  it('rejects impossible shares', () => {
    expect(() => share(5, 4)).toThrow(RangeError);
    expect(() => share(1, 0)).toThrow(RangeError);
    expect(() => share(0.5, 2)).toThrow(RangeError);
  });
});

/** Builds a distribution whose top K groups first reach 60%. */
function distributionWithK(k: number, respondents = 1000): number[] {
  // k-1 groups that stay below 60% combined, then one group crossing it, then small tail.
  const before = Math.floor((0.6 * respondents - 1) / k);
  const groups = Array.from({ length: k - 1 }, () => before);
  const crossing = Math.ceil(0.6 * respondents) - before * (k - 1);
  groups.push(Math.max(crossing, 1));
  let rest = respondents - groups.reduce((a, b) => a + b, 0);
  while (rest > 0) {
    const g = Math.min(rest, 1);
    groups.push(g);
    rest -= g;
  }
  return groups;
}

describe('K and guess cap (§23.1 examples)', () => {
  it.each([
    [2, 10],
    [8, 11],
    [15, 18],
    [17, 20],
  ])('K=%i -> cap %i', (k, cap) => {
    const counts = distributionWithK(k);
    expect(computeK(counts, 1000)).toBe(k);
    expect(guessCap(k)).toBe(cap);
    expect(gameEligibility(counts, 1000)).toEqual({ eligible: true, k, cap });
  });

  it('K=18 is not playable yet', () => {
    const counts = distributionWithK(18);
    expect(computeK(counts, 1000)).toBe(18);
    expect(gameEligibility(counts, 1000)).toEqual({ eligible: false, reason: 'k_too_high', k: 18 });
  });

  it('needs 100 genuine respondents', () => {
    expect(gameEligibility([60, 39], 99)).toMatchObject({
      eligible: false,
      reason: 'too_few_respondents',
    });
    expect(gameEligibility([60, 40], 100)).toEqual({ eligible: true, k: 1, cap: 10 });
  });

  it('exactly 60% counts as reaching it; ordering of ties does not matter', () => {
    expect(computeK([30, 30, 40], 100)).toBe(2); // 40 + 30 = 70
    expect(computeK([20, 20, 20, 20, 20], 100)).toBe(3);
  });
});
