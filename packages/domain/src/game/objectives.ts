/**
 * Mystery Challenge objectives (update §6; starter list approved by the owner as G3).
 * Each challenge gets one special objective instead of the usual 60% goal. Normal guess cap
 * and three-strike rules still apply. An objective is only offered when the poll's frozen
 * results make it achievable.
 */
import { rankedGroups } from './replay.js';
import { meetsTarget, type Share } from './share.js';

export type Objective =
  | { type: 'top_answer'; groups: string[] }
  | { type: 'top_three'; groups: string[] }
  | { type: 'deep_cut'; underPercent: 5; groups: string[] }
  | { type: 'clean_sweep' }
  | { type: 'efficient'; maxGuesses: number };

export type ObjectiveType = Objective['type'];

export function describeObjective(o: Objective): string {
  switch (o.type) {
    case 'top_answer':
      return 'Find the #1 answer';
    case 'top_three':
      return 'Find all of the top 3 answers';
    case 'deep_cut':
      return 'Find an answer fewer than 5% of people gave';
    case 'clean_sweep':
      return 'Reach 60% without a single wrong guess';
    case 'efficient':
      return `Reach 60% using no more than ${o.maxGuesses} guesses`;
  }
}

export interface FrozenResults {
  respondents: number;
  distribution: Readonly<Record<string, number>>;
  k: number;
  guessCap: number;
}

/** Every objective that is genuinely achievable on these frozen results. */
export function achievableObjectives(r: FrozenResults): Objective[] {
  const ranked = rankedGroups({ respondents: r.respondents, distribution: r.distribution });
  const count = (g: string) => r.distribution[g] ?? 0;
  const out: Objective[] = [];
  if (ranked.length > 0) {
    const top = count(ranked[0]!);
    out.push({ type: 'top_answer', groups: ranked.filter((g) => count(g) === top) });
  }
  // Top three only when 3rd place isn't tied with 4th (otherwise "the top 3" is ambiguous).
  if (
    ranked.length >= 3 &&
    r.guessCap >= 3 &&
    (ranked.length === 3 || count(ranked[2]!) > count(ranked[3]!))
  ) {
    out.push({ type: 'top_three', groups: ranked.slice(0, 3) });
  }
  const deep = ranked.filter((g) => count(g) * 100 < 5 * r.respondents);
  if (deep.length > 0) out.push({ type: 'deep_cut', underPercent: 5, groups: deep });
  if (r.k <= r.guessCap) out.push({ type: 'clean_sweep' });
  if (r.k + 1 <= r.guessCap) out.push({ type: 'efficient', maxGuesses: r.k + 1 });
  return out;
}

export interface ChallengeProgress {
  found: ReadonlySet<string>;
  score: Share;
  strikes: number;
  accepted: number;
}

/** 'completed' as soon as the objective is met; 'failed' once it can no longer be met. */
export function objectiveStatus(
  o: Objective,
  p: ChallengeProgress,
): 'completed' | 'failed' | 'ongoing' {
  switch (o.type) {
    case 'top_answer':
    case 'deep_cut':
      return o.groups.some((g) => p.found.has(g)) ? 'completed' : 'ongoing';
    case 'top_three':
      return o.groups.every((g) => p.found.has(g)) ? 'completed' : 'ongoing';
    case 'clean_sweep':
      if (p.strikes > 0) return 'failed';
      return meetsTarget(p.score) ? 'completed' : 'ongoing';
    case 'efficient':
      if (meetsTarget(p.score)) return p.accepted <= o.maxGuesses ? 'completed' : 'failed';
      return p.accepted >= o.maxGuesses ? 'failed' : 'ongoing';
  }
}
