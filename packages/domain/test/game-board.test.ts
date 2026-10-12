// Spec §5 and update §2: guesses, strikes, cap, duplicates, team pools and credit.
import { describe, expect, it } from 'vitest';
import { GuessBoard, share, type BoardConfig } from '../src/index.js';

const dist = new Map([
  ['keys', 40],
  ['wallet', 25],
  ['phone', 15],
  ['gum', 10],
  ['lipstick', 6],
  ['mints', 4],
]);
const cfg = (over: Partial<BoardConfig> = {}): BoardConfig => ({
  distribution: dist,
  respondents: 100,
  guessCap: 10,
  stopAtTarget: false,
  ...over,
});
const right = (groupId: string, by = 'u1', at = 1) => ({ groupId, key: groupId, by, at });
const wrong = (key: string, by = 'u1', at = 1) => ({ groupId: null, key, by, at });

describe('GuessBoard', () => {
  it('adds the frozen share of each correct answer', () => {
    const b = new GuessBoard(cfg());
    expect(b.submit(right('keys'))).toEqual({
      kind: 'correct',
      groupId: 'keys',
      groupShare: share(40, 100),
      score: share(40, 100),
    });
    b.submit(right('phone'));
    expect(b.score()).toEqual(share(55, 100));
    expect(b.correctCount).toBe(2);
  });

  it('repeat answers are neutral: no points, no attempt, no strike (correct or wrong)', () => {
    const b = new GuessBoard(cfg());
    b.submit(right('keys'));
    b.submit(wrong('banana'));
    expect(b.submit(right('keys'))).toEqual({ kind: 'already_guessed' });
    expect(b.submit(wrong('banana'))).toEqual({ kind: 'already_guessed' });
    expect(b.accepted).toBe(2);
    expect(b.strikes).toBe(1);
    expect(b.score()).toEqual(share(40, 100));
  });

  it('third wrong guess ends play', () => {
    const b = new GuessBoard(cfg());
    b.submit(wrong('a'));
    b.submit(wrong('b'));
    expect(b.finished).toBe(false);
    b.submit(wrong('c'));
    expect(b.finishedReason).toBe('strikes');
    expect(() => b.submit(right('keys'))).toThrow();
  });

  it('guess cap counts correct and wrong guesses', () => {
    const b = new GuessBoard(cfg({ guessCap: 3 }));
    b.submit(right('mints'));
    b.submit(wrong('x'));
    expect(b.remaining).toBe(1);
    b.submit(right('gum'));
    expect(b.finishedReason).toBe('cap');
  });

  it('solo stops at 60%; multiplayer setting can keep going', () => {
    const solo = new GuessBoard(cfg({ stopAtTarget: true }));
    solo.submit(right('keys'));
    expect(solo.finished).toBe(false); // 40%
    solo.submit(right('wallet'));
    expect(solo.finishedReason).toBe('target'); // 65%

    const multi = new GuessBoard(cfg({ stopAtTarget: false }));
    multi.submit(right('keys'));
    multi.submit(right('wallet'));
    expect(multi.finished).toBe(false);
    multi.submit(right('phone'));
    expect(multi.score()).toEqual(share(80, 100));
  });

  it('time of reaching the score is the last scoring guess', () => {
    const b = new GuessBoard(cfg());
    expect(b.reachedScoreAt).toBeNull();
    b.submit(right('keys', 'u1', 100));
    b.submit(wrong('x', 'u1', 200));
    expect(b.reachedScoreAt).toBe(100);
    b.submit(right('gum', 'u1', 300));
    expect(b.reachedScoreAt).toBe(300);
  });

  it('team boards share one pool and credit each teammate', () => {
    const team = new GuessBoard(cfg());
    team.submit(right('keys', 'ann'));
    expect(team.submit(right('keys', 'bob'))).toEqual({ kind: 'already_guessed' });
    team.submit(right('wallet', 'bob'));
    team.submit(right('mints', 'bob'));
    team.submit(wrong('x', 'ann'));
    team.submit(wrong('y', 'bob'));
    expect(team.strikes).toBe(2); // shared strikes
    expect(team.score()).toEqual(share(69, 100));
    expect(Object.fromEntries(team.contributions())).toEqual({
      ann: { answers: 1, count: 40 },
      bob: { answers: 2, count: 29 },
    });
  });

  it('opponents earn the same answer independently', () => {
    const a = new GuessBoard(cfg());
    const b = new GuessBoard(cfg());
    a.submit(right('keys'));
    expect(b.submit(right('keys'))).toMatchObject({ kind: 'correct', score: share(40, 100) });
  });
});
