// Spec §4, §5, §23.2: grouping, guess matching, replay rule.
import { describe, expect, it } from 'vitest';
import {
  canonicalKeys,
  matchGuess,
  materialChange,
  replayEligible,
  type SnapshotView,
} from '../src/index.js';

describe('grouping', () => {
  it('folds plurals into a singular that was also answered', () => {
    const m = canonicalKeys(['key', 'keys', 'glasses', 'candies', 'candy', 'boxes', 'box', 'gas']);
    expect(m.get('keys')).toBe('key');
    expect(m.get('candies')).toBe('candy');
    expect(m.get('boxes')).toBe('box');
    expect(m.get('glasses')).toBe('glasses'); // no "glasse"/"glass" answered
    expect(m.get('gas')).toBe('gas');
  });
  it('does not fold when the singular was never answered', () => {
    expect(canonicalKeys(['keys']).get('keys')).toBe('keys');
  });
  it('staff aliases win', () => {
    const m = canonicalKeys(
      ['cell phone', 'phone', 'mobile'],
      new Map([
        ['mobile', 'phone'],
        ['cell phone', 'phone'],
      ]),
    );
    expect(m.get('mobile')).toBe('phone');
    expect(m.get('cell phone')).toBe('phone');
  });
});

describe('matchGuess', () => {
  const keymap = {
    key: 'g1',
    keys: 'g1',
    wallet: 'g2',
    lipstick: 'g3',
    'lip balm': 'g4',
    phone: 'g5',
  };
  it('matches exact, punctuation and article variants', () => {
    expect(matchGuess('The Keys!', keymap).groupId).toBe('g1');
    expect(matchGuess('my wallet', keymap).groupId).toBe('g2');
  });
  it('matches plural variants not seen in answers', () => {
    expect(matchGuess('wallets', keymap).groupId).toBe('g2');
    expect(matchGuess('phones', keymap).groupId).toBe('g5');
  });
  it('allows one typo on longer words when unambiguous', () => {
    expect(matchGuess('walet', keymap).groupId).toBe('g2');
    expect(matchGuess('lipstik', keymap).groupId).toBe('g3');
    expect(matchGuess('lipsitck', keymap).groupId).toBe('g3'); // adjacent swap
  });
  it('does not stretch short words or wrong answers', () => {
    expect(matchGuess('kee', keymap).groupId).toBeNull();
    expect(matchGuess('banana', keymap).groupId).toBeNull();
  });
});

const snap = (respondents: number, distribution: Record<string, number>): SnapshotView => ({
  respondents,
  distribution,
});
const day = 86_400_000;

describe('replay eligibility (§23.2, AT-11)', () => {
  const prev = snap(100, { a: 40, b: 30, c: 15, d: 10, e: 5 });
  const base = new Date('2026-01-01T00:00:00Z');

  it('needs 30 days', () => {
    const cur = snap(130, { a: 40, b: 50, c: 20, d: 12, e: 8 });
    expect(
      replayEligible({
        lastPlayedAt: base,
        previous: prev,
        current: cur,
        now: new Date(base.getTime() + 29 * day),
      }),
    ).toBe(false);
    expect(
      replayEligible({
        lastPlayedAt: base,
        previous: prev,
        current: cur,
        now: new Date(base.getTime() + 30 * day),
      }),
    ).toBe(true);
  });

  it('needs at least 120% respondents', () => {
    const now = new Date(base.getTime() + 40 * day);
    expect(
      replayEligible({
        lastPlayedAt: base,
        previous: prev,
        current: snap(119, { a: 20, b: 60, c: 19, d: 10, e: 10 }),
        now,
      }),
    ).toBe(false);
    expect(
      replayEligible({
        lastPlayedAt: base,
        previous: prev,
        current: snap(120, { a: 20, b: 60, c: 20, d: 10, e: 10 }),
        now,
      }),
    ).toBe(true);
  });

  it('a 5-point move in a top-five group counts; 4.9 does not', () => {
    // a: 40% -> 45% exactly
    expect(materialChange(prev, snap(200, { a: 90, b: 60, c: 30, d: 12, e: 8 }))).toBe(true);
    // a: 40% -> 44.9%; every other group moves less than 5 points; top three unchanged
    expect(materialChange(prev, snap(1000, { a: 449, b: 280, c: 140, d: 90, e: 41 }))).toBe(false);
  });

  it('a top-three order change counts', () => {
    expect(materialChange(prev, snap(100, { a: 30, b: 40, c: 15, d: 10, e: 5 }))).toBe(true);
  });

  it('top-five membership change alone is not enough', () => {
    // e (5%) leaves the top five, f (6%) enters; nothing moves 5 points; top three same.
    const cur = snap(1000, { a: 400, b: 300, c: 150, d: 100, f: 46, e: 4 });
    expect(materialChange(prev, cur)).toBe(false);
  });
});
