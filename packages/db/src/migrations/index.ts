import type { Migration } from 'kysely/migration';
import * as m0001 from './0001_baseline.js';
import * as m0002 from './0002_identity.js';
import * as m0003 from './0003_polls.js';

/** Ordered registry. Never rename or reorder an applied migration; add new ones at the end. */
export const migrations: Record<string, Migration> = {
  '0001_baseline': m0001,
  '0002_identity': m0002,
  '0003_polls': m0003,
};
