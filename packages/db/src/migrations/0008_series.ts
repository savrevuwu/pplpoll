import { sql, type Kysely } from 'kysely';

/** Best-of-3 / Best-of-5 series for Head-to-Head and Teams (update §4, G1, G8, G11). */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE series (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      best_of integer NOT NULL CHECK (best_of IN (3, 5)),
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended','no_contest')),
      winner_side_index integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz,
      CHECK ((status = 'ended') = (winner_side_index IS NOT NULL))
    )
  `.execute(db);
  await sql`ALTER TABLE matches ADD COLUMN best_of integer NOT NULL DEFAULT 1 CHECK (best_of IN (1, 3, 5))`.execute(
    db,
  );
  await sql`ALTER TABLE matches ADD COLUMN series_id uuid REFERENCES series(id)`.execute(db);
  await sql`ALTER TABLE matches ADD COLUMN round_number integer`.execute(db);
  await sql`ALTER TABLE matches ADD CONSTRAINT matches_series_rounds CHECK ((series_id IS NULL) = (round_number IS NULL))`.execute(
    db,
  );
  await sql`ALTER TABLE matches ADD CONSTRAINT matches_best_of_modes CHECK (best_of = 1 OR mode IN ('h2h','teams'))`.execute(
    db,
  );
  await sql`CREATE UNIQUE INDEX matches_series_round ON matches (series_id, round_number) WHERE series_id IS NOT NULL`.execute(
    db,
  );
  // Later rounds of a private series have no room code of their own.
  await sql`ALTER TABLE matches DROP CONSTRAINT matches_private_room_code`.execute(db);
  await sql`ALTER TABLE matches ADD CONSTRAINT matches_private_lobby_code CHECK (NOT (source = 'private' AND status = 'lobby' AND series_id IS NULL) OR room_code IS NOT NULL)`.execute(
    db,
  );
  await sql`ALTER TABLE matchmaking_queue ADD COLUMN best_of integer NOT NULL DEFAULT 1 CHECK (best_of IN (1, 3, 5))`.execute(
    db,
  );
  await sql`DROP INDEX matchmaking_queue_order`.execute(db);
  await sql`CREATE INDEX matchmaking_queue_order ON matchmaking_queue (mode, format, best_of, enqueued_at)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM series) THEN RAISE EXCEPTION 'cannot roll back 0008_series: series exist'; END IF;
    END $$
  `.execute(db);
  await sql`DROP INDEX matchmaking_queue_order`.execute(db);
  await sql`ALTER TABLE matchmaking_queue DROP COLUMN best_of`.execute(db);
  await sql`CREATE INDEX matchmaking_queue_order ON matchmaking_queue (mode, format, enqueued_at)`.execute(
    db,
  );
  await sql`ALTER TABLE matches DROP CONSTRAINT matches_private_lobby_code`.execute(db);
  await sql`ALTER TABLE matches ADD CONSTRAINT matches_private_room_code CHECK ((source = 'private') = (room_code IS NOT NULL))`.execute(
    db,
  );
  await sql`DROP INDEX matches_series_round`.execute(db);
  await sql`ALTER TABLE matches DROP CONSTRAINT matches_best_of_modes`.execute(db);
  await sql`ALTER TABLE matches DROP CONSTRAINT matches_series_rounds`.execute(db);
  await sql`ALTER TABLE matches DROP COLUMN round_number`.execute(db);
  await sql`ALTER TABLE matches DROP COLUMN series_id`.execute(db);
  await sql`ALTER TABLE matches DROP COLUMN best_of`.execute(db);
  await sql`DROP TABLE series`.execute(db);
}
