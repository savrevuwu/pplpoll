// Spec §10 / §23.7 / §24: one-year deactivation, warning exactly 30 days before deadline.
import { describe, expect, it } from 'vitest';
import { addEtYears, deactivationSchedule, etDate } from '../src/index.js';

describe('deactivationSchedule', () => {
  it('gives a full calendar year and a warning 30 days before the deadline', () => {
    // Deactivated 2026-10-12 14:00 EDT.
    const s = deactivationSchedule(new Date('2026-10-12T18:00:00Z'));
    expect(s.lastReactivationDate).toBe('2027-10-12');
    expect(s.deletionDueAt.toISOString()).toBe('2027-10-13T04:00:00.000Z'); // 00:00 EDT
    expect(etDate(s.warningDueAt)).toBe('2027-09-13');
    expect(s.warningDueAt.toISOString()).toBe('2027-09-13T04:00:00.000Z');
  });

  it('uses the ET date, not the UTC date', () => {
    // 2026-10-13T02:00Z is still 2026-10-12 in New York.
    expect(deactivationSchedule(new Date('2026-10-13T02:00:00Z')).lastReactivationDate).toBe(
      '2027-10-12',
    );
  });

  it('handles a deadline in winter time', () => {
    const s = deactivationSchedule(new Date('2026-12-20T17:00:00Z'));
    expect(s.deletionDueAt.toISOString()).toBe('2027-12-21T05:00:00.000Z');
    expect(s.warningDueAt.toISOString()).toBe('2027-11-21T05:00:00.000Z');
  });
});

describe('addEtYears', () => {
  it('moves Feb 29 to Mar 1 in non-leap years', () => {
    expect(addEtYears('2028-02-29', 1)).toBe('2029-03-01');
    expect(addEtYears('2027-02-28', 1)).toBe('2028-02-28');
    expect(addEtYears('2026-10-12', 1)).toBe('2027-10-12');
  });
});
