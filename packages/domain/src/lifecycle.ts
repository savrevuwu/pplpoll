/**
 * Voluntary deactivation schedule (spec §10, §23.7).
 *
 * - The deactivation period is one calendar year, counted in America/New_York dates.
 * - Final deletion becomes due at 12:00 AM ET on the day after the one-year anniversary,
 *   so the period is never shorter than a full year. A Feb 29 anniversary falls on Mar 1.
 * - The warning email is due exactly 30 calendar days before the deletion deadline.
 */
import { addEtDays, etDate, etDayStart, type EtDate } from './time.js';

export interface DeactivationSchedule {
  /** Last ET date the account can still be reactivated by signing in. */
  lastReactivationDate: EtDate;
  deletionDueAt: Date;
  warningDueAt: Date;
}

export const DEACTIVATION_WARNING_DAYS = 30;

export function addEtYears(date: EtDate, years: number): EtDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const target = `${String(y + years).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (m === 2 && d === 29) {
    const isLeap = (yr: number) => (yr % 4 === 0 && yr % 100 !== 0) || yr % 400 === 0;
    if (!isLeap(y + years)) return `${String(y + years).padStart(4, '0')}-03-01`;
  }
  return target;
}

export function deactivationSchedule(deactivatedAt: Date): DeactivationSchedule {
  const lastReactivationDate = addEtYears(etDate(deactivatedAt), 1);
  const deletionDate = addEtDays(lastReactivationDate, 1);
  return {
    lastReactivationDate,
    deletionDueAt: etDayStart(deletionDate),
    warningDueAt: etDayStart(addEtDays(deletionDate, -DEACTIVATION_WARNING_DAYS)),
  };
}
