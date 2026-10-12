import type { Migration } from 'kysely/migration';
import * as m0001 from './0001_baseline.js';

/** Ordered registry. Never rename or reorder an applied migration; add new ones at the end. */
export const migrations: Record<string, Migration> = {
  '0001_baseline': m0001,
};
