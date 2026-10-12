// Spec §10: username and display-name rules.
import { describe, expect, it } from 'vitest';
import {
  cooldownEndsAt,
  isAcceptablePassword,
  isPlausibleEmail,
  isValidUsername,
  normalizeDisplayName,
  normalizeEmail,
  usernameKey,
} from '../src/index.js';

describe('usernames', () => {
  it.each(['abc', 'ABC123', 'a'.repeat(20), 'Zz9'])('accepts %s', (u) => {
    expect(isValidUsername(u)).toBe(true);
  });
  it.each(['ab', 'a'.repeat(21), 'has_underscore', 'has space', 'émile', 'dot.name', ''])(
    'rejects %s',
    (u) => expect(isValidUsername(u)).toBe(false),
  );
  it('reserves case-insensitively', () => {
    expect(usernameKey('PollMaster')).toBe(usernameKey('pollmaster'));
  });
});

describe('display names', () => {
  it('trims and accepts letters, numbers and spaces', () => {
    expect(normalizeDisplayName('  Jo Smith 2 ')).toEqual({ ok: true, value: 'Jo Smith 2' });
    expect(normalizeDisplayName('x'.repeat(20))).toEqual({ ok: true, value: 'x'.repeat(20) });
  });
  it.each(['', '   ', 'x'.repeat(21), 'Jo!', 'Jo😀', 'Jo-Smith', 'tab\there'])('rejects %j', (n) =>
    expect(normalizeDisplayName(n)).toEqual({ ok: false }),
  );
  it('cooldown is exactly 168 hours', () => {
    expect(cooldownEndsAt(new Date('2026-10-01T00:00:00Z')).toISOString()).toBe(
      '2026-10-08T00:00:00.000Z',
    );
  });
});

describe('email and password', () => {
  it('normalizes email', () => {
    expect(normalizeEmail('  Jo@Example.COM ')).toBe('jo@example.com');
    expect(isPlausibleEmail('jo@example.com')).toBe(true);
    expect(isPlausibleEmail('jo@example')).toBe(false);
    expect(isPlausibleEmail('jo example.com')).toBe(false);
  });
  it('bounds password length', () => {
    expect(isAcceptablePassword('x'.repeat(9))).toBe(false);
    expect(isAcceptablePassword('x'.repeat(10))).toBe(true);
    expect(isAcceptablePassword('x'.repeat(129))).toBe(false);
  });
});
