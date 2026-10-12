import { sql, type Kysely } from 'kysely';

/**
 * Milestone 3: survey responses, daily assignments, streaks, notification settings (spec §3, §4, §17, §18).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // One accepted survey response per person per poll, for life (spec §1). Keyed on the
  // participation identity so deleting and re-creating an account can't answer again.
  await sql`
    CREATE TABLE survey_responses (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      poll_id uuid NOT NULL REFERENCES polls(id),
      participation_identity_id uuid NOT NULL REFERENCES participation_identities(id),
      user_id uuid REFERENCES users(id),
      et_date date NOT NULL,
      context text NOT NULL CHECK (context IN ('daily_poll','assignment')),
      daily_feature_id uuid REFERENCES daily_features(id),
      assignment_slot smallint CHECK (assignment_slot BETWEEN 1 AND 10),
      counts_for_progress boolean NOT NULL,
      normalized_key text NOT NULL,
      normalization_version smallint NOT NULL,
      answer_group_id uuid,
      status text NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','removed')),
      submitted_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (poll_id, participation_identity_id),
      CHECK ((context = 'daily_poll') = (daily_feature_id IS NOT NULL)),
      CHECK ((context = 'assignment') = (assignment_slot IS NOT NULL))
    )
  `.execute(db);
  await sql`CREATE INDEX survey_responses_user_day_idx ON survey_responses (user_id, et_date)`.execute(
    db,
  );
  await sql`CREATE INDEX survey_responses_poll_key_idx ON survey_responses (poll_id, normalized_key) WHERE status = 'accepted'`.execute(
    db,
  );

  // A poll can be answered only after its Daily Poll debut (spec §2.2, AT-01).
  await sql`
    CREATE FUNCTION survey_responses_require_answerable_poll() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE s text;
    BEGIN
      SELECT status INTO s FROM polls WHERE id = NEW.poll_id;
      IF s IS NULL OR s NOT IN ('live_daily','survey') THEN
        RAISE EXCEPTION 'poll % is not open for survey responses', NEW.poll_id USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $$
  `.execute(db);
  await sql`
    CREATE TRIGGER survey_responses_answerable BEFORE INSERT ON survey_responses
    FOR EACH ROW EXECUTE FUNCTION survey_responses_require_answerable_poll()
  `.execute(db);

  // Raw text kept separately for quality review only, encrypted, restricted (spec §4).
  await sql`
    CREATE TABLE survey_response_raw (
      response_id uuid PRIMARY KEY REFERENCES survey_responses(id) ON DELETE CASCADE,
      raw_text_enc text NOT NULL
    )
  `.execute(db);

  await sql`
    CREATE TABLE daily_assignments (
      user_id uuid NOT NULL REFERENCES users(id),
      et_date date NOT NULL,
      slot smallint NOT NULL CHECK (slot BETWEEN 1 AND 10),
      poll_id uuid NOT NULL REFERENCES polls(id),
      response_id uuid REFERENCES survey_responses(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, et_date, slot),
      UNIQUE (user_id, et_date, poll_id)
    )
  `.execute(db);

  await sql`
    CREATE TABLE streaks (
      user_id uuid NOT NULL REFERENCES users(id),
      kind text NOT NULL CHECK (kind IN ('answering','guessing')),
      current integer NOT NULL DEFAULT 0 CHECK (current >= 0),
      longest integer NOT NULL DEFAULT 0 CHECK (longest >= current),
      last_et_date date,
      PRIMARY KEY (user_id, kind)
    )
  `.execute(db);

  await sql`
    CREATE TABLE notification_settings (
      user_id uuid PRIMARY KEY REFERENCES users(id),
      daily_poll_announcement boolean NOT NULL DEFAULT true,
      answering_reminder boolean NOT NULL DEFAULT false,
      guessing_reminder boolean NOT NULL DEFAULT false
    )
  `.execute(db);
  await sql`
    CREATE TABLE daily_announcement_seen (
      user_id uuid NOT NULL REFERENCES users(id),
      et_date date NOT NULL,
      PRIMARY KEY (user_id, et_date)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of [
    'daily_announcement_seen',
    'notification_settings',
    'streaks',
    'daily_assignments',
    'survey_response_raw',
    'survey_responses',
  ]) {
    await sql`DROP TABLE ${sql.table(t)}`.execute(db);
  }
  await sql`DROP FUNCTION survey_responses_require_answerable_poll()`.execute(db);
}
