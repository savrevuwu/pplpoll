import type { Kysely } from 'kysely';
import { Migrator, type MigrationResultSet } from 'kysely/migration';
import { migrations } from './migrations/index.js';

export function createMigrator(db: Kysely<unknown>): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
  });
}

function unwrap(result: MigrationResultSet): MigrationResultSet {
  if (result.error) throw result.error;
  return result;
}

export async function migrateToLatest(db: Kysely<unknown>): Promise<MigrationResultSet> {
  return unwrap(await createMigrator(db).migrateToLatest());
}

export async function migrateDownOne(db: Kysely<unknown>): Promise<MigrationResultSet> {
  return unwrap(await createMigrator(db).migrateDown());
}

/** Rolls back every migration. For tests and local resets only — never run against production data. */
export async function migrateDownAll(db: Kysely<unknown>): Promise<void> {
  const migrator = createMigrator(db);
  for (;;) {
    const result = unwrap(await migrator.migrateDown());
    if (!result.results || result.results.length === 0) return;
  }
}
