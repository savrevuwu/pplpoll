import { sql, type Kysely } from 'kysely';

/**
 * Milestone 4: answer groups, 24-hour result snapshots, solo guessing games, the shared daily
 * guessing allowance, played polls, Rarest Correct Guess (spec §4–§6, §23.1–§23.3, update §8–§9).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE answer_groups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      poll_id uuid NOT NULL REFERENCES polls(id),
      canonical_key text NOT NULL,
      label text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (poll_id, canonical_key)
    )
  `.execute(db);
  // Staff merges (synonyms, spellings). Automatic plural folding needs no rows.
  await sql`
    CREATE TABLE answer_aliases (
      poll_id uuid NOT NULL REFERENCES polls(id),
      normalized_key text NOT NULL,
      canonical_key text NOT NULL,
      created_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (poll_id, normalized_key)
    )
  `.execute(db);

  // Immutable, versioned results published once per ET day (§4, §19).
  await sql`
    CREATE TABLE result_snapshots (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      poll_id uuid NOT NULL REFERENCES polls(id),
      et_date date NOT NULL,
      version integer NOT NULL,
      respondents integer NOT NULL CHECK (respondents >= 0),
      k integer,
      guess_cap integer CHECK (guess_cap BETWEEN 10 AND 20),
      eligible boolean NOT NULL,
      ineligible_reason text,
      distribution jsonb NOT NULL,
      keymap jsonb NOT NULL,
      labels jsonb NOT NULL,
      grouping_version smallint NOT NULL,
      computed_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (poll_id, et_date),
      UNIQUE (poll_id, version),
      CHECK (NOT eligible OR (respondents >= 100 AND k <= 17 AND guess_cap IS NOT NULL))
    )
  `.execute(db);
  await sql`
    CREATE TRIGGER result_snapshots_immutable BEFORE UPDATE OR DELETE ON result_snapshots
    FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation()
  `.execute(db);

  await sql`
    CREATE TABLE games (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mode text NOT NULL CHECK (mode IN ('solo')),
      poll_id uuid NOT NULL REFERENCES polls(id),
      snapshot_id uuid NOT NULL REFERENCES result_snapshots(id),
      user_id uuid NOT NULL REFERENCES users(id),
      state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','ended')),
      outcome text CHECK (outcome IN ('won','lost','released')),
      score_count integer NOT NULL DEFAULT 0,
      score_total integer NOT NULL,
      strikes integer NOT NULL DEFAULT 0 CHECK (strikes BETWEEN 0 AND 3),
      accepted integer NOT NULL DEFAULT 0,
      correct_count integer NOT NULL DEFAULT 0,
      guess_cap integer NOT NULL,
      reached_score_at timestamptz,
      valid boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz,
      CHECK ((state = 'ended') = (outcome IS NOT NULL))
    )
  `.execute(db);

  // One active guessing participation per account, across devices and modes (§23.3).
  await sql`
    CREATE TABLE game_participations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      game_id uuid NOT NULL REFERENCES games(id),
      user_id uuid NOT NULL REFERENCES users(id),
      active boolean NOT NULL DEFAULT true,
      charge_et_date date,
      first_guess_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz,
      UNIQUE (game_id, user_id)
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX game_participations_one_active ON game_participations (user_id) WHERE active`.execute(
    db,
  );

  // Shared 10-per-day charged guessing games (solo and every multiplayer mode).
  await sql`
    CREATE TABLE daily_charges (
      user_id uuid NOT NULL REFERENCES users(id),
      et_date date NOT NULL,
      charged integer NOT NULL CHECK (charged BETWEEN 0 AND 10),
      PRIMARY KEY (user_id, et_date)
    )
  `.execute(db);
  await sql`
    CREATE TABLE allowance_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id),
      participation_id uuid NOT NULL REFERENCES game_participations(id),
      kind text NOT NULL CHECK (kind IN ('reserve','charge','release')),
      et_date date NOT NULL,
      at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (participation_id, kind)
    )
  `.execute(db);
  await sql`
    CREATE TRIGGER allowance_events_append_only BEFORE UPDATE OR DELETE ON allowance_events
    FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation()
  `.execute(db);

  await sql`
    CREATE TABLE guesses (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      -- Exact submission order, even for guesses in the same millisecond.
      ord bigint GENERATED ALWAYS AS IDENTITY,
      game_id uuid NOT NULL REFERENCES games(id),
      participation_id uuid NOT NULL REFERENCES game_participations(id),
      submitted_by uuid NOT NULL REFERENCES users(id),
      client_request_id text NOT NULL,
      seq integer,
      normalized_key text NOT NULL,
      group_id text,
      result text NOT NULL CHECK (result IN ('correct','incorrect','duplicate')),
      share_count integer,
      share_total integer,
      raw_text_enc text NOT NULL,
      at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (game_id, client_request_id),
      -- Neutral duplicates are never numbered (§5).
      CHECK ((result = 'duplicate') = (seq IS NULL))
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX guesses_seq ON guesses (game_id, seq) WHERE seq IS NOT NULL`.execute(
    db,
  );

  await sql`
    CREATE TABLE played_polls (
      user_id uuid NOT NULL REFERENCES users(id),
      poll_id uuid NOT NULL REFERENCES polls(id),
      first_played_at timestamptz NOT NULL,
      last_played_at timestamptz NOT NULL,
      last_snapshot_id uuid NOT NULL REFERENCES result_snapshots(id),
      plays integer NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, poll_id)
    )
  `.execute(db);

  // Personal Rarest Correct Guess (update §8), at the frozen snapshot share.
  await sql`
    CREATE TABLE player_rarest (
      user_id uuid PRIMARY KEY REFERENCES users(id),
      share_count integer NOT NULL CHECK (share_count > 0),
      share_total integer NOT NULL CHECK (share_total >= share_count),
      guess_id uuid NOT NULL REFERENCES guesses(id),
      achieved_at timestamptz NOT NULL
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of [
    'player_rarest',
    'played_polls',
    'guesses',
    'allowance_events',
    'daily_charges',
    'game_participations',
    'games',
    'result_snapshots',
    'answer_aliases',
    'answer_groups',
  ]) {
    await sql`DROP TABLE ${sql.table(t)}`.execute(db);
  }
}
