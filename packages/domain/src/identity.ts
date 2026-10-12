/**
 * Account identity rules (spec §10).
 * Pure validation; the database enforces the same rules with CHECK constraints.
 */

export const USERNAME_RE = /^[A-Za-z0-9]{3,20}$/;

/** Usernames: 3–20 ASCII letters/digits. Uniqueness is case-insensitive and permanent. */
export function isValidUsername(username: string): boolean {
  return USERNAME_RE.test(username);
}

/** Key used for permanent case-insensitive reservation. */
export function usernameKey(username: string): string {
  return username.toLowerCase();
}

// Display names: letters, numbers and spaces only. ASCII for now (see docs/decisions.md Q6).
const DISPLAY_NAME_RE = /^[A-Za-z0-9 ]{1,20}$/;

export type DisplayNameResult = { ok: true; value: string } | { ok: false };

/** Trims, then checks 1–20 letters/numbers/spaces with at least one non-space. */
export function normalizeDisplayName(input: string): DisplayNameResult {
  const value = input.trim();
  if (value.length === 0 || !DISPLAY_NAME_RE.test(value)) return { ok: false };
  return { ok: true, value };
}

/** Voluntary display-name changes and photo uploads wait 168 hours (spec §10, §11). */
export const PROFILE_COOLDOWN_MS = 168 * 3600_000;

export function cooldownEndsAt(lastChangeAt: Date): Date {
  return new Date(lastChangeAt.getTime() + PROFILE_COOLDOWN_MS);
}

/** Emails are compared after trimming and lower-casing the whole address. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;

export function isPlausibleEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email);
}

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export function isAcceptablePassword(password: string): boolean {
  return password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX;
}
