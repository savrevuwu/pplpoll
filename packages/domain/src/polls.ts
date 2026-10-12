/**
 * Poll question text rules (spec §9).
 */

export const QUESTION_MIN = 10;
export const QUESTION_MAX = 200;

/** Trims, collapses internal whitespace, and removes control characters. */
export function cleanQuestionText(input: string): string {
  return input
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isValidQuestionText(text: string): boolean {
  return text.length >= QUESTION_MIN && text.length <= QUESTION_MAX && /[A-Za-z]/.test(text);
}

/**
 * Key for exact-duplicate detection after trivial punctuation/case/spacing normalization (§9).
 * "Name something in your purse!" and "name something in your purse" share a key.
 */
export function questionExactKey(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Starter list that routes a proposal to the sensitive/gray-area review queue.
 * This only picks a queue — staff always decide, and can move proposals between queues.
 * The list is configuration the owner/staff can change; it is not a content policy.
 */
export const DEFAULT_SENSITIVE_TERMS: readonly string[] = [
  'abortion',
  'alcohol',
  'death',
  'die',
  'drug',
  'drugs',
  'gun',
  'guns',
  'kill',
  'politics',
  'political',
  'religion',
  'religious',
  'race',
  'sex',
  'sexual',
  'suicide',
  'weapon',
  'weapons',
];

export function mentionsSensitiveTerm(
  text: string,
  terms: readonly string[] = DEFAULT_SENSITIVE_TERMS,
): boolean {
  const words = new Set(questionExactKey(text).split(' '));
  return terms.some((t) => words.has(t));
}

/** Similarity (pg_trgm, 0..1) at or above this routes to the similar-duplicate queue. */
export const SIMILARITY_THRESHOLD = 0.6;

/**
 * Rejection reasons (§9): good-faith reasons refund the 1 PP; prohibited/malicious/abusive/spam do not.
 */
export const REFUNDABLE_REASONS = [
  'duplicate_exact',
  'duplicate_similar',
  'quality',
  'unsuitable_gameplay',
  'other_good_faith',
] as const;
export const NON_REFUNDABLE_REASONS = ['prohibited', 'malicious', 'abusive', 'spam'] as const;
export type RejectionReason =
  (typeof REFUNDABLE_REASONS)[number] | (typeof NON_REFUNDABLE_REASONS)[number];

export function isRefundable(reason: RejectionReason): boolean {
  return (REFUNDABLE_REASONS as readonly string[]).includes(reason);
}
