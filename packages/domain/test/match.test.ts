// Update §1–§3, G4, G5, G7: player counts, Classic turns, places and outcomes.
import { describe, expect, it } from 'vitest';
import { advanceTurns, outcomes, placements, validPlayerCount } from '../src/index.js';

describe('player counts', () => {
  it('Head-to-Head is exactly 2, Teams exactly 4, Free-for-All 3 to 6', () => {
    expect([1, 2, 3].map((n) => validPlayerCount('h2h', n))).toEqual([false, true, false]);
    expect([3, 4, 5].map((n) => validPlayerCount('teams', n))).toEqual([false, true, false]);
    expect([2, 3, 6, 7].map((n) => validPlayerCount('ffa', n))).toEqual([false, true, true, false]);
  });
});

describe('Classic turns', () => {
  const order = ['a', 'b', 'c'];
  it('stays with the current side inside the 15 s turn', () => {
    expect(advanceTurns({ order, index: 0, startedAt: 0 }, new Set(), 14_999)).toMatchObject({
      index: 0,
      startedAt: 0,
      timedOut: 0,
    });
  });
  it('passes the turn on timeout, with no strike, possibly several times', () => {
    expect(advanceTurns({ order, index: 0, startedAt: 0 }, new Set(), 15_000)).toMatchObject({
      index: 1,
      startedAt: 15_000,
      timedOut: 1,
    });
    expect(advanceTurns({ order, index: 0, startedAt: 0 }, new Set(), 46_000)).toMatchObject({
      index: 0,
      startedAt: 45_000,
      timedOut: 3,
    });
  });
  it('skips finished sides', () => {
    expect(advanceTurns({ order, index: 0, startedAt: 0 }, new Set(['b']), 15_000)).toMatchObject({
      index: 2,
    });
    expect(advanceTurns({ order, index: 1, startedAt: 0 }, new Set(['b']), 1_000)).toMatchObject({
      index: 2,
    });
  });
});

describe('places and outcomes (G7)', () => {
  it('uses 1, 1, 3 numbering and keeps real ties', () => {
    const p = placements([['a'], ['b', 'c'], ['d']]);
    expect(Object.fromEntries(p)).toEqual({ a: 1, b: 2, c: 2, d: 4 });
  });
  it('a lone 1st wins; a shared 1st draws; everyone else loses', () => {
    expect(Object.fromEntries(outcomes([['a'], ['b', 'c']]))).toEqual({
      a: 'win',
      b: 'loss',
      c: 'loss',
    });
    expect(Object.fromEntries(outcomes([['a', 'b'], ['c']]))).toEqual({
      a: 'draw',
      b: 'draw',
      c: 'loss',
    });
    expect(Object.fromEntries(outcomes([['x', 'y']]))).toEqual({ x: 'draw', y: 'draw' });
  });
});
