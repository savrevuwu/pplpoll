// Update §3, §4, §8, §9: tiebreakers, placements, series, rarest record.
import { describe, expect, it } from 'vitest';
import {
  duelOutcome,
  isRarer,
  rankStandings,
  recordHolders,
  share,
  tallySeries,
  type Standing,
} from '../src/index.js';

const s = (
  id: string,
  count: number,
  reachedAt: number | null,
  correctCount: number,
  total = 100,
): Standing => ({
  id,
  score: share(count, total),
  reachedAt,
  correctCount,
});

describe('tiebreakers', () => {
  it('1. higher exact share wins', () => {
    expect(duelOutcome(s('a', 61, 500, 4), s('b', 60, 100, 2))).toBe('a');
    // 1/3 of 300 vs 100 of 301: different respondents never happen within a match, but compare exactly anyway
    expect(duelOutcome(s('a', 100, 1, 1, 300), s('b', 100, 1, 1, 301))).toBe('a');
  });
  it('2. same share: earlier time wins', () => {
    expect(duelOutcome(s('a', 55, 900, 3), s('b', 55, 800, 5))).toBe('b');
  });
  it('3. same share and time: fewer correct guesses wins', () => {
    expect(duelOutcome(s('a', 55, 800, 3), s('b', 55, 800, 2))).toBe('b');
  });
  it('4. everything equal: genuine draw', () => {
    expect(duelOutcome(s('a', 55, 800, 3), s('b', 55, 800, 3))).toBe('draw');
    expect(duelOutcome(s('a', 0, null, 0), s('b', 0, null, 0))).toBe('draw');
  });
});

describe('Free-for-All ranking', () => {
  it('orders players into tie groups, keeping genuine ties', () => {
    const groups = rankStandings([
      s('p1', 40, 100, 2),
      s('p2', 70, 300, 4),
      s('p3', 40, 100, 2),
      s('p4', 40, 50, 3),
      s('p5', 0, null, 0),
    ]);
    expect(groups).toEqual([['p2'], ['p4'], ['p1', 'p3'], ['p5']]);
  });
});

describe('best-of series', () => {
  it('needs a majority: 2 of 3, 3 of 5', () => {
    expect(tallySeries(3, ['a', 'b', 'a'])).toEqual({ winsA: 2, winsB: 1, needed: 2, winner: 'a' });
    expect(tallySeries(5, ['b', 'b', 'a'])).toMatchObject({ winner: null, needed: 3 });
    expect(tallySeries(5, ['b', 'b', 'a', 'b'])).toMatchObject({ winner: 'b' });
  });
  it('rejects rounds after the series is decided', () => {
    expect(() => tallySeries(3, ['a', 'a', 'b'])).toThrow();
  });
});

describe('rarest correct guess', () => {
  it('a strictly lower share replaces the personal record; equal does not', () => {
    expect(isRarer(share(2, 100), null)).toBe(true);
    expect(isRarer(share(1, 120), share(1, 100))).toBe(true);
    expect(isRarer(share(1, 100), share(1, 100))).toBe(false);
    expect(isRarer(share(2, 200), share(1, 100))).toBe(false);
  });
  it('record holders: lowest share, ties share the badge', () => {
    expect(recordHolders([])).toBeNull();
    expect(
      recordHolders([
        { userId: 'c', share: share(3, 100) },
        { userId: 'b', share: share(1, 250) },
        { userId: 'a', share: share(2, 500) },
      ]),
    ).toEqual({ share: share(1, 250), userIds: ['a', 'b'] });
  });
  it('removing an invalidated record recomputes holders', () => {
    const bests = [
      { userId: 'cheat', share: share(1, 1000) },
      { userId: 'fair', share: share(1, 300) },
    ];
    expect(recordHolders(bests)!.userIds).toEqual(['cheat']);
    expect(recordHolders(bests.filter((b) => b.userId !== 'cheat'))!.userIds).toEqual(['fair']);
  });
});
