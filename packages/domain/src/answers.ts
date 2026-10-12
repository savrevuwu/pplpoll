/**
 * Survey answer rules (spec §4). Answering a survey is not a game: one free-text answer,
 * then "Thank you for your response".
 */

export const ANSWER_MAX = 80;

export function cleanAnswer(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalization rules version, stored with every response so grouping is reproducible (§4, §19). */
export const ANSWER_NORMALIZATION_VERSION = 1;

/**
 * Key used to count matching answers ("The Keys!" and "keys" share a key).
 * Spelling variants, plurals and synonyms are merged later by versioned answer groups (M4).
 */
export function answerKey(text: string): string {
  return cleanAnswer(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(a|an|the|my|some) (?=\S)/, '');
}

const NON_ANSWERS = new Set([
  'idk',
  'i dont know',
  'dont know',
  'dunno',
  'no idea',
  'not sure',
  'na',
  'n a',
  'pass',
  'skip',
  'asdf',
  'asdfgh',
  'qwerty',
  'test',
  'testing',
  'lol',
  'lmao',
  'whatever',
  'blah',
  'none of your business',
]);

/** Staff-configurable blocked terms for abusive answers. Starts empty; moderation removes the rest (M6). */
export const DEFAULT_BLOCKED_ANSWER_TERMS: readonly string[] = [];

export type AnswerCheck =
  | { ok: true; text: string; key: string }
  | { ok: false; reason: 'empty' | 'too_long' | 'not_an_answer' | 'link' | 'blocked' };

/**
 * Deterministic quality gate. Rejected answers are not stored and do not use up the person's
 * one answer, so they can try again. Never rejects only because an answer is unusual.
 */
export function checkAnswer(
  input: string,
  blockedTerms: readonly string[] = DEFAULT_BLOCKED_ANSWER_TERMS,
): AnswerCheck {
  const text = cleanAnswer(input);
  if (text.length === 0 || !/[\p{L}\p{N}]/u.test(text)) return { ok: false, reason: 'empty' };
  if (text.length > ANSWER_MAX) return { ok: false, reason: 'too_long' };
  if (/(https?:\/\/|www\.|\.(com|net|org|io|gg)\b|@\S+\.\S+)/i.test(text))
    return { ok: false, reason: 'link' };
  const key = answerKey(text);
  if (key.length === 0 || NON_ANSWERS.has(key)) return { ok: false, reason: 'not_an_answer' };
  // One character repeated (aaaa) or long consonant-only keyboard mashes (sdfghjk).
  if (/^(.)\1{3,}$/u.test(key.replace(/\s/g, ''))) return { ok: false, reason: 'not_an_answer' };
  if (key.split(' ').some((w) => w.length >= 6 && /^[a-z]+$/.test(w) && !/[aeiouy]/.test(w))) {
    return { ok: false, reason: 'not_an_answer' };
  }
  const words = new Set(key.split(' '));
  if (blockedTerms.some((t) => words.has(t))) return { ok: false, reason: 'blocked' };
  return { ok: true, text, key };
}

/** Daily target: 1 Daily Poll + 10 more existing surveys = 11 accepted responses → 1 PP (§3). */
export const DAILY_REGULAR_SLOTS = 10;
export const DAILY_TARGET = 1 + DAILY_REGULAR_SLOTS;
