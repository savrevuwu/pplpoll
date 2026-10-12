/**
 * Business-day math for The People Poll (spec §3, §23.3).
 *
 * The global day boundary is 12:00 AM America/New_York, including EST/EDT changes.
 * An "ET date" is a calendar date string `YYYY-MM-DD` in that zone.
 * Pure functions only: callers pass the instant, so tests can control time.
 */

export const BUSINESS_TIME_ZONE = 'America/New_York';

/** Calendar date in America/New_York, formatted `YYYY-MM-DD`. */
export type EtDate = string;

const ET_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClockAt(instant: Date): WallClock {
  const ms = instant.getTime();
  if (!Number.isFinite(ms)) throw new RangeError('Invalid instant');
  const fields: Record<string, number> = {};
  for (const p of partsFormatter.formatToParts(instant)) {
    if (p.type !== 'literal') fields[p.type] = Number(p.value);
  }
  return {
    year: fields.year!,
    month: fields.month!,
    day: fields.day!,
    hour: fields.hour!,
    minute: fields.minute!,
    second: fields.second!,
  };
}

/** Offset of America/New_York from UTC at `instant`, in milliseconds (e.g. -4h during EDT). */
export function etOffsetMs(instant: Date): number {
  const w = wallClockAt(instant);
  const wallAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const wholeSecond = Math.floor(instant.getTime() / 1000) * 1000;
  return wallAsUtc - wholeSecond;
}

/** The America/New_York calendar date containing `instant`. */
export function etDate(instant: Date): EtDate {
  const w = wallClockAt(instant);
  return formatDate(w.year, w.month, w.day);
}

function formatDate(year: number, month: number, day: number): EtDate {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function parseEtDate(date: EtDate): { y: number; m: number; d: number } {
  const match = ET_DATE_RE.exec(date);
  if (!match) throw new RangeError(`Invalid ET date: ${date}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    throw new RangeError(`Invalid ET date: ${date}`);
  }
  return { y, m, d };
}

/**
 * The UTC instant of 12:00 AM America/New_York on `date`.
 * New York DST transitions happen at 2 AM, so local midnight always exists exactly once.
 */
export function etDayStart(date: EtDate): Date {
  const { y, m, d } = parseEtDate(date);
  const wallMidnightAsUtc = Date.UTC(y, m - 1, d);
  // First estimate using the offset a few hours later, then correct with the offset at the result.
  const estimate = wallMidnightAsUtc - etOffsetMs(new Date(wallMidnightAsUtc + 5 * 3600_000));
  return new Date(wallMidnightAsUtc - etOffsetMs(new Date(estimate)));
}

/** Adds whole calendar days to an ET date. */
export function addEtDays(date: EtDate, days: number): EtDate {
  if (!Number.isInteger(days)) throw new RangeError('days must be an integer');
  const { y, m, d } = parseEtDate(date);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return formatDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** The next 12:00 AM America/New_York strictly after `instant`. */
export function nextEtMidnight(instant: Date): Date {
  return etDayStart(addEtDays(etDate(instant), 1));
}

/** Length of an ET calendar day in hours (23 on spring-forward day, 25 on fall-back day). */
export function etDayLengthHours(date: EtDate): number {
  return (etDayStart(addEtDays(date, 1)).getTime() - etDayStart(date).getTime()) / 3600_000;
}
