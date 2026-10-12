// M0-02: migrations run up -> down -> up cleanly; audit log is append-only in the database.
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, migrateDownAll, migrateToLatest } from '../src/index.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for integration tests');

let db: Kysely<unknown>;

async function auditTableExists(): Promise<boolean> {
  const r = await sql<{ t: string | null }>`SELECT to_regclass('audit.events')::text AS t`.execute(
    db,
  );
  return r.rows[0]?.t != null;
}

beforeAll(async () => {
  db = createDb(url) as unknown as Kysely<unknown>;
  await migrateDownAll(db);
});

afterAll(async () => {
  await migrateDownAll(db);
  await db.destroy();
});

describe('migrations', () => {
  it('apply up, roll back fully, and re-apply', async () => {
    await migrateToLatest(db);
    expect(await auditTableExists()).toBe(true);

    await migrateDownAll(db);
    expect(await auditTableExists()).toBe(false);

    await migrateToLatest(db);
    expect(await auditTableExists()).toBe(true);
  });

  it('are idempotent when already at latest', async () => {
    const result = await migrateToLatest(db);
    expect(result.results).toEqual([]);
  });
});

describe('audit.events', () => {
  it('accepts inserts', async () => {
    await sql`INSERT INTO audit.events (action, target_type, target_id) VALUES ('test.insert', 'thing', '1')`.execute(
      db,
    );
    const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM audit.events`.execute(db);
    expect(r.rows[0]?.n).toBeGreaterThan(0);
  });

  it('rejects UPDATE, DELETE and TRUNCATE', async () => {
    await expect(sql`UPDATE audit.events SET action = 'tampered'`.execute(db)).rejects.toThrow(
      /append-only/,
    );
    await expect(sql`DELETE FROM audit.events`.execute(db)).rejects.toThrow(/append-only/);
    await expect(sql`TRUNCATE audit.events`.execute(db)).rejects.toThrow(/append-only/);
  });
});
