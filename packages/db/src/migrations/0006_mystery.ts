import { sql, type Kysely } from 'kysely';

/** Mystery Challenge (update §6): a solo mode with one special objective per game. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE games DROP CONSTRAINT games_mode_check`.execute(db);
  await sql`ALTER TABLE games ADD CONSTRAINT games_mode_check CHECK (mode IN ('solo','mystery'))`.execute(
    db,
  );
  await sql`ALTER TABLE games ADD COLUMN objective jsonb`.execute(db);
  await sql`ALTER TABLE games ADD CONSTRAINT games_objective_for_mystery CHECK ((mode = 'mystery') = (objective IS NOT NULL))`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Never silently delete game history: refuse to roll back once Mystery games exist.
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM games WHERE mode = 'mystery') THEN
        RAISE EXCEPTION 'cannot roll back 0006_mystery: mystery games exist';
      END IF;
    END $$
  `.execute(db);
  await sql`ALTER TABLE games DROP CONSTRAINT games_objective_for_mystery`.execute(db);
  await sql`ALTER TABLE games DROP COLUMN objective`.execute(db);
  await sql`ALTER TABLE games DROP CONSTRAINT games_mode_check`.execute(db);
  await sql`ALTER TABLE games ADD CONSTRAINT games_mode_check CHECK (mode IN ('solo'))`.execute(db);
}
