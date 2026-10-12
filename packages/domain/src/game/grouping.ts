/**
 * Answer grouping and guess matching (spec §4, §5). Deterministic and versioned so every
 * frozen snapshot is reproducible.
 *
 * - Survey answers are stored with a normalized key (see answers.ts).
 * - Keys that differ only by a plural "s"/"es" fold into one group automatically.
 * - Staff can merge further keys (synonyms, spellings) into a group; those aliases win.
 * - A guess matches a group by exact key, plural variant, or — for words of 5+ letters — a single
 *   typo, but only if exactly one group is that close (never a guess between two groups).
 */
import { answerKey } from '../answers.js';

export const GROUPING_VERSION = 1;

/** Candidate singular forms used for automatic plural folding. */
export function singularForms(key: string): string[] {
  const out = new Set<string>();
  if (key.length > 3 && key.endsWith('ies')) out.add(`${key.slice(0, -3)}y`);
  if (key.length > 3 && /(ses|xes|zes|ches|shes)$/.test(key)) out.add(key.slice(0, -2));
  if (key.length > 2 && key.endsWith('s') && !key.endsWith('ss')) out.add(key.slice(0, -1));
  return [...out];
}

/**
 * Maps every distinct key to a canonical key. Staff aliases first; otherwise a plural folds into
 * its singular when that singular was also answered. Returns key -> canonical key.
 */
export function canonicalKeys(
  keys: readonly string[],
  staffAliases: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
  const present = new Set(keys);
  const out = new Map<string, string>();
  for (const k of keys) {
    const staff = staffAliases.get(k);
    if (staff) {
      out.set(k, staff);
      continue;
    }
    const singular = singularForms(k).find((s) => present.has(s) && !staffAliases.has(s));
    out.set(k, singular ?? k);
  }
  return out;
}

function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      // substitution or adjacent swap
      if (a[i + 1] === b[j] && a[i] === b[j + 1]) {
        i += 2;
        j += 2;
        continue;
      }
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Finds the answer group for a guess using a frozen key -> group map.
 * Returns null when the guess matches no group (or is ambiguous between groups).
 */
export function matchGuess(
  guess: string,
  keymap: Readonly<Record<string, string>>,
): { key: string; groupId: string | null } {
  const key = answerKey(guess);
  const direct = keymap[key];
  if (direct) return { key, groupId: direct };
  for (const variant of [...singularForms(key), `${key}s`, `${key}es`]) {
    const g = keymap[variant];
    if (g) return { key, groupId: g };
  }
  if (key.replace(/\s/g, '').length >= 5) {
    const groups = new Set<string>();
    for (const [k, g] of Object.entries(keymap)) {
      if (k.length >= 5 && withinOneEdit(key, k)) groups.add(g);
    }
    if (groups.size === 1) return { key, groupId: [...groups][0]! };
  }
  return { key, groupId: null };
}
