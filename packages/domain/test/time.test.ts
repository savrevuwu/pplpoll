// M0-01: ET business-day math around midnight and both DST transitions (spec §3).
import { describe, expect, it } from 'vitest';
import {
  addEtDays,
  etDate,
  etDayLengthHours,
  etDayStart,
  etOffsetMs,
  nextEtMidnight,
} from '../src/index.js';

const at = (iso: string) => new Date(iso);

describe('etDate', () => {
  it('uses the New York date, not the UTC date', () => {
    // 2026-10-10 02:30 UTC is still 2026-10-09 22:30 EDT.
    expect(etDate(at('2026-10-10T02:30:00Z'))).toBe('2026-10-09');
  });

  it('changes exactly at 12:00 AM EDT', () => {
    expect(etDate(at('2026-10-10T03:59:59.999Z'))).toBe('2026-10-09');
    expect(etDate(at('2026-10-10T04:00:00.000Z'))).toBe('2026-10-10');
  });

  it('changes exactly at 12:00 AM EST', () => {
    expect(etDate(at('2026-12-01T04:59:59.999Z'))).toBe('2026-11-30');
    expect(etDate(at('2026-12-01T05:00:00.000Z'))).toBe('2026-12-01');
  });

  it('handles year boundaries', () => {
    expect(etDate(at('2027-01-01T04:59:59.999Z'))).toBe('2026-12-31');
    expect(etDate(at('2027-01-01T05:00:00.000Z'))).toBe('2027-01-01');
  });

  it('rejects invalid instants', () => {
    expect(() => etDate(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe('etOffsetMs', () => {
  it('is -4h in summer and -5h in winter', () => {
    expect(etOffsetMs(at('2026-07-01T12:00:00Z'))).toBe(-4 * 3600_000);
    expect(etOffsetMs(at('2026-01-15T12:00:00Z'))).toBe(-5 * 3600_000);
  });
});

describe('etDayStart', () => {
  it('returns midnight EST/EDT as a UTC instant', () => {
    expect(etDayStart('2026-10-10').toISOString()).toBe('2026-10-10T04:00:00.000Z');
    expect(etDayStart('2026-12-01').toISOString()).toBe('2026-12-01T05:00:00.000Z');
  });

  it('is correct on spring-forward day (2026-03-08) and the day after', () => {
    // Midnight on 03-08 is still EST; the jump happens at 2 AM.
    expect(etDayStart('2026-03-08').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(etDayStart('2026-03-09').toISOString()).toBe('2026-03-09T04:00:00.000Z');
  });

  it('is correct on fall-back day (2026-11-01) and the day after', () => {
    expect(etDayStart('2026-11-01').toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(etDayStart('2026-11-02').toISOString()).toBe('2026-11-02T05:00:00.000Z');
  });

  it('round-trips with etDate for every day of a year', () => {
    let d = '2026-01-01';
    for (let i = 0; i < 366; i++) {
      const start = etDayStart(d);
      expect(etDate(start)).toBe(d);
      expect(etDate(new Date(start.getTime() - 1))).toBe(addEtDays(d, -1));
      d = addEtDays(d, 1);
    }
  });

  it('rejects malformed or impossible dates', () => {
    expect(() => etDayStart('2026-2-1')).toThrow(RangeError);
    expect(() => etDayStart('2026-02-30')).toThrow(RangeError);
  });
});

describe('etDayLengthHours', () => {
  it('is 23h on spring-forward, 25h on fall-back, 24h otherwise', () => {
    expect(etDayLengthHours('2026-03-08')).toBe(23);
    expect(etDayLengthHours('2026-11-01')).toBe(25);
    expect(etDayLengthHours('2026-10-10')).toBe(24);
  });
});

describe('nextEtMidnight', () => {
  it('returns the following ET midnight', () => {
    expect(nextEtMidnight(at('2026-10-10T03:59:59.999Z')).toISOString()).toBe(
      '2026-10-10T04:00:00.000Z',
    );
    expect(nextEtMidnight(at('2026-10-10T04:00:00.000Z')).toISOString()).toBe(
      '2026-10-11T04:00:00.000Z',
    );
  });

  it('crosses the fall-back night correctly (game started 11:55 PM)', () => {
    // 2026-10-31 23:55 EDT = 2026-11-01T03:55Z; next midnight is 2026-11-01 00:00 EDT.
    expect(nextEtMidnight(at('2026-11-01T03:55:00Z')).toISOString()).toBe(
      '2026-11-01T04:00:00.000Z',
    );
  });
});

describe('addEtDays', () => {
  it('handles month/leap-year rollover', () => {
    expect(addEtDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addEtDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addEtDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});
