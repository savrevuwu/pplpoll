// Update §6 / G3: Mystery Challenge objectives are achievable and judged exactly.
import { describe, expect, it } from 'vitest';
import {
  achievableObjectives,
  describeObjective,
  objectiveStatus,
  share,
  type Objective,
} from '../src/index.js';

const purse = {
  respondents: 100,
  distribution: { keys: 40, wallet: 25, phone: 15, gum: 10, lipstick: 6, mints: 4 },
  k: 2,
  guessCap: 10,
};
const progress = (
  found: string[],
  score: number,
  strikes = 0,
  accepted = found.length + strikes,
) => ({
  found: new Set(found),
  score: share(score, 100),
  strikes,
  accepted,
});

describe('achievable objectives', () => {
  it('offers all five on a normal poll', () => {
    const types = achievableObjectives(purse).map((o) => o.type);
    expect(types).toEqual(['top_answer', 'top_three', 'deep_cut', 'clean_sweep', 'efficient']);
    const deep = achievableObjectives(purse).find((o) => o.type === 'deep_cut') as Extract<
      Objective,
      { type: 'deep_cut' }
    >;
    expect(deep.groups).toEqual(['mints']);
  });
  it('skips objectives the results cannot support', () => {
    const noDeep = { respondents: 100, distribution: { a: 50, b: 30, c: 20 }, k: 2, guessCap: 10 };
    expect(achievableObjectives(noDeep).map((o) => o.type)).not.toContain('deep_cut');
    const tiedThird = {
      respondents: 100,
      distribution: { a: 50, b: 20, c: 15, d: 15 },
      k: 2,
      guessCap: 10,
    };
    expect(achievableObjectives(tiedThird).map((o) => o.type)).not.toContain('top_three');
  });
  it('a tied #1 accepts either answer', () => {
    const tie = { respondents: 100, distribution: { a: 35, b: 35, c: 30 }, k: 2, guessCap: 10 };
    const top = achievableObjectives(tie)[0] as Extract<Objective, { type: 'top_answer' }>;
    expect(top.groups.sort()).toEqual(['a', 'b']);
  });
  it('efficient allows K+1 guesses', () => {
    expect(describeObjective({ type: 'efficient', maxGuesses: 3 })).toBe(
      'Reach 60% using no more than 3 guesses',
    );
  });
});

describe('objective status', () => {
  const [top, three, deep, clean, eff] = achievableObjectives(purse);
  it('top answer / deep cut complete on finding a matching group', () => {
    expect(objectiveStatus(top!, progress(['wallet'], 25))).toBe('ongoing');
    expect(objectiveStatus(top!, progress(['keys'], 40))).toBe('completed');
    expect(objectiveStatus(deep!, progress(['mints'], 4))).toBe('completed');
  });
  it('top three needs all three', () => {
    expect(objectiveStatus(three!, progress(['keys', 'wallet'], 65))).toBe('ongoing');
    expect(objectiveStatus(three!, progress(['keys', 'wallet', 'phone'], 80))).toBe('completed');
  });
  it('clean sweep fails on the first wrong guess', () => {
    expect(objectiveStatus(clean!, progress(['keys'], 40, 1))).toBe('failed');
    expect(objectiveStatus(clean!, progress(['keys', 'wallet'], 65))).toBe('completed');
  });
  it('efficient fails once the guess budget passes without 60%', () => {
    expect(objectiveStatus(eff!, progress(['keys', 'wallet'], 65))).toBe('completed'); // 2 <= 3
    expect(objectiveStatus(eff!, progress(['keys', 'gum'], 50, 1, 3))).toBe('failed');
    expect(objectiveStatus(eff!, progress(['keys'], 40, 1, 2))).toBe('ongoing');
  });
});
