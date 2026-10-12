/**
 * Survey-to-gameplay gate and guess cap (spec §5, §23.1).
 */
export const MIN_RESPONDENTS = 100;
export const MAX_K = 17;
export const MAX_STRIKES = 3;

/**
 * K = smallest number of answer groups, taken from most to least popular, whose combined
 * respondents reach at least 60% of all respondents. Ties in ordering don't change K.
 */
export function computeK(groupCounts: readonly number[], respondents: number): number | null {
  if (respondents <= 0) return null;
  const sorted = [...groupCounts].sort((a, b) => b - a);
  let sum = 0;
  for (let i = 0; i < sorted.length; i++) {
    sum += sorted[i]!;
    if (sum * 100 >= 60 * respondents) return i + 1;
  }
  return null;
}

/** Total accepted guesses allowed: min(20, max(10, K + 3)). */
export function guessCap(k: number): number {
  return Math.min(20, Math.max(10, k + 3));
}

export type Eligibility =
  | { eligible: true; k: number; cap: number }
  | { eligible: false; reason: 'too_few_respondents' | 'k_too_high' | 'no_k'; k: number | null };

export function gameEligibility(groupCounts: readonly number[], respondents: number): Eligibility {
  const k = computeK(groupCounts, respondents);
  if (respondents < MIN_RESPONDENTS) return { eligible: false, reason: 'too_few_respondents', k };
  if (k === null) return { eligible: false, reason: 'no_k', k };
  if (k > MAX_K) return { eligible: false, reason: 'k_too_high', k };
  return { eligible: true, k, cap: guessCap(k) };
}
