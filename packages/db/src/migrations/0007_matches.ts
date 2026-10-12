import { sql, type Kysely } from 'kysely';

/**
 * Multiplayer matches (update §1–§3): Head-to-Head, Teams, Free-for-All × Classic/Speed,
 * public matchmaking and private rooms. Participations are shared with solo games so the
 * one-active-game rule and the 10-a-day allowance cover every mode (§23.3).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE matches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mode text NOT NULL CHECK (mode IN ('h2h','teams','ffa')),
      format text NOT NULL CHECK (format IN ('classic','speed')),
      source text NOT NULL CHECK (source IN ('public','private')),
      status text NOT NULL DEFAULT 'lobby' CHECK (status IN ('lobby','active','ended','closed')),
      room_code text UNIQUE,
      host_user_id uuid REFERENCES users(id),
      poll_id uuid REFERENCES polls(id),
      snapshot_id uuid REFERENCES result_snapshots(id),
      started_at timestamptz,
      ends_at timestamptz,
      turn_order jsonb,
      turn_index integer,
      turn_started_at timestamptz,
      ended_at timestamptz,
      valid boolean NOT NULL DEFAULT true,
      state_version integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (status IN ('lobby','closed') OR (poll_id IS NOT NULL AND snapshot_id IS NOT NULL AND started_at IS NOT NULL AND ends_at IS NOT NULL)),
      CONSTRAINT matches_private_room_code CHECK ((source = 'private') = (room_code IS NOT NULL))
    )
  `.execute(db);
  await sql`CREATE INDEX matches_active_idx ON matches (ends_at) WHERE status = 'active'`.execute(
    db,
  );

  await sql`
    CREATE TABLE match_sides (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      match_id uuid NOT NULL REFERENCES matches(id),
      side_index integer NOT NULL,
      rotation jsonb NOT NULL DEFAULT '[]'::jsonb,
      rotation_index integer NOT NULL DEFAULT 0,
      score_count integer NOT NULL DEFAULT 0,
      strikes integer NOT NULL DEFAULT 0 CHECK (strikes BETWEEN 0 AND 3),
      accepted integer NOT NULL DEFAULT 0,
      correct_count integer NOT NULL DEFAULT 0,
      reached_score_at timestamptz,
      finished boolean NOT NULL DEFAULT false,
      placement integer,
      outcome text CHECK (outcome IN ('win','loss','draw')),
      UNIQUE (match_id, side_index)
    )
  `.execute(db);

  await sql`
    CREATE TABLE match_players (
      match_id uuid NOT NULL REFERENCES matches(id),
      user_id uuid NOT NULL REFERENCES users(id),
      side_id uuid REFERENCES match_sides(id),
      preferred_team integer CHECK (preferred_team IN (0, 1)),
      joined_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (match_id, user_id)
    )
  `.execute(db);

  // Public matchmaking: first available compatible players, not skill-based (§7).
  await sql`
    CREATE TABLE matchmaking_queue (
      user_id uuid PRIMARY KEY REFERENCES users(id),
      mode text NOT NULL CHECK (mode IN ('h2h','teams','ffa')),
      format text NOT NULL CHECK (format IN ('classic','speed')),
      enqueued_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE INDEX matchmaking_queue_order ON matchmaking_queue (mode, format, enqueued_at)`.execute(
    db,
  );

  // One participation table for every guessing mode.
  await sql`ALTER TABLE game_participations ALTER COLUMN game_id DROP NOT NULL`.execute(db);
  await sql`ALTER TABLE game_participations ADD COLUMN match_id uuid REFERENCES matches(id)`.execute(
    db,
  );
  await sql`ALTER TABLE game_participations ADD CONSTRAINT game_participations_one_target CHECK ((game_id IS NULL) <> (match_id IS NULL))`.execute(
    db,
  );
  await sql`CREATE UNIQUE INDEX game_participations_match_user ON game_participations (match_id, user_id) WHERE match_id IS NOT NULL`.execute(
    db,
  );

  await sql`
    CREATE TABLE match_guesses (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ord bigint GENERATED ALWAYS AS IDENTITY,
      match_id uuid NOT NULL REFERENCES matches(id),
      side_id uuid NOT NULL REFERENCES match_sides(id),
      submitted_by uuid NOT NULL REFERENCES users(id),
      client_request_id text NOT NULL,
      seq integer,
      normalized_key text NOT NULL,
      group_id text,
      result text NOT NULL CHECK (result IN ('correct','incorrect','duplicate')),
      share_count integer,
      share_total integer,
      raw_text_enc text NOT NULL,
      at timestamptz NOT NULL,
      UNIQUE (match_id, submitted_by, client_request_id),
      CHECK ((result = 'duplicate') = (seq IS NULL))
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX match_guesses_side_seq ON match_guesses (side_id, seq) WHERE seq IS NOT NULL`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM matches WHERE status <> 'lobby') THEN
        RAISE EXCEPTION 'cannot roll back 0007_matches: matches exist';
      END IF;
    END $$
  `.execute(db);
  await sql`DROP TABLE match_guesses`.execute(db);
  await sql`DROP INDEX game_participations_match_user`.execute(db);
  await sql`ALTER TABLE game_participations DROP CONSTRAINT game_participations_one_target`.execute(
    db,
  );
  await sql`ALTER TABLE game_participations DROP COLUMN match_id`.execute(db);
  await sql`ALTER TABLE game_participations ALTER COLUMN game_id SET NOT NULL`.execute(db);
  for (const t of ['matchmaking_queue', 'match_players', 'match_sides', 'matches']) {
    await sql`DROP TABLE ${sql.table(t)}`.execute(db);
  }
}
