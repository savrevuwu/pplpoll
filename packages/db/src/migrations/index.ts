import type { Migration } from 'kysely/migration';
import * as m0001 from './0001_baseline.js';
import * as m0002 from './0002_identity.js';
import * as m0003 from './0003_polls.js';
import * as m0004 from './0004_surveys.js';
import * as m0005 from './0005_guessing.js';
import * as m0006 from './0006_mystery.js';
import * as m0007 from './0007_matches.js';

/** Ordered registry. Never rename or reorder an applied migration; add new ones at the end. */
export const migrations: Record<string, Migration> = {
  '0001_baseline': m0001,
  '0002_identity': m0002,
  '0003_polls': m0003,
  '0004_surveys': m0004,
  '0005_guessing': m0005,
  '0006_mystery': m0006,
  '0007_matches': m0007,
};
