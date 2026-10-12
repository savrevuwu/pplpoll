import { sql, type Kysely } from 'kysely';

/**
 * Milestone 2: Poll Points ledger, proposals, polls, Daily Poll queue/calendar/features,
 * exceptions, in-app notifications (spec §2, §3, §9, §18, §23.6).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.execute(db);

  // Global "Hide my name on all polls" switch (§9).
  await sql`ALTER TABLE users ADD COLUMN hide_name_on_polls boolean NOT NULL DEFAULT false`.execute(
    db,
  );

  await sql`
    CREATE TABLE pp_accounts (
      user_id uuid PRIMARY KEY REFERENCES users(id),
      balance integer NOT NULL DEFAULT 0 CHECK (balance >= 0)
    )
  `.execute(db);
  // Append-only, auditable PP ledger (§3, §19).
  await sql`
    CREATE TABLE pp_ledger (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id),
      delta integer NOT NULL CHECK (delta <> 0),
      kind text NOT NULL CHECK (kind IN ('daily_award','proposal_debit','proposal_refund','refund_reversal')),
      ref_id uuid,
      et_date date,
      actor_user_id uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX pp_ledger_one_award_per_day ON pp_ledger (user_id, et_date) WHERE kind = 'daily_award'`.execute(
    db,
  );
  await sql`CREATE UNIQUE INDEX pp_ledger_one_debit_per_proposal ON pp_ledger (ref_id) WHERE kind = 'proposal_debit'`.execute(
    db,
  );
  await sql`CREATE INDEX pp_ledger_user_idx ON pp_ledger (user_id, created_at)`.execute(db);
  await sql`
    CREATE TRIGGER pp_ledger_append_only BEFORE UPDATE OR DELETE ON pp_ledger
    FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation()
  `.execute(db);

  await sql`
    CREATE TABLE poll_proposals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      creator_user_id uuid NOT NULL REFERENCES users(id),
      text text NOT NULL CHECK (length(text) BETWEEN 10 AND 200),
      exact_key text NOT NULL,
      visibility text NOT NULL CHECK (visibility IN ('public','anonymous')),
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected')),
      route text NOT NULL CHECK (route IN ('normal','sensitive','similarity')),
      idempotency_key text NOT NULL,
      similar_to jsonb NOT NULL DEFAULT '[]'::jsonb,
      refunded boolean NOT NULL DEFAULT false,
      decision_reason text,
      decided_by uuid REFERENCES users(id),
      decided_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (creator_user_id, idempotency_key)
    )
  `.execute(db);
  await sql`CREATE INDEX poll_proposals_queue_idx ON poll_proposals (route, created_at) WHERE status = 'pending'`.execute(
    db,
  );
  await sql`CREATE INDEX poll_proposals_exact_idx ON poll_proposals (exact_key) WHERE status = 'pending'`.execute(
    db,
  );

  await sql`
    CREATE TABLE polls (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      proposal_id uuid UNIQUE REFERENCES poll_proposals(id),
      text text NOT NULL CHECK (length(text) BETWEEN 10 AND 200),
      exact_key text NOT NULL UNIQUE,
      creator_user_id uuid REFERENCES users(id),
      creator_visibility text NOT NULL CHECK (creator_visibility IN ('public','anonymous')),
      status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','live_daily','survey','removed')),
      debut_et_date date,
      response_count integer NOT NULL DEFAULT 0 CHECK (response_count >= 0),
      approved_by uuid REFERENCES users(id),
      approved_at timestamptz NOT NULL DEFAULT now(),
      removed_at timestamptz,
      removed_reason text,
      -- A queued poll has never debuted and has zero responses (§2).
      CHECK (status <> 'queued' OR (response_count = 0 AND debut_et_date IS NULL)),
      CHECK (status = 'queued' OR status = 'removed' OR debut_et_date IS NOT NULL)
    )
  `.execute(db);
  await sql`CREATE INDEX polls_queue_idx ON polls (approved_at) WHERE status = 'queued'`.execute(
    db,
  );
  await sql`CREATE INDEX polls_trgm_idx ON polls USING gin (exact_key gin_trgm_ops)`.execute(db);

  // Staff-only calendar of upcoming Daily Polls (§2.3).
  await sql`
    CREATE TABLE daily_schedule (
      et_date date PRIMARY KEY,
      poll_id uuid NOT NULL UNIQUE REFERENCES polls(id),
      scheduled_by uuid NOT NULL REFERENCES users(id),
      scheduled_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  // What actually ran each day. A poll can be featured at most once, ever (§2.7).
  await sql`
    CREATE TABLE daily_features (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      et_date date NOT NULL,
      poll_id uuid NOT NULL UNIQUE REFERENCES polls(id),
      kind text NOT NULL CHECK (kind IN ('primary','emergency_replacement')),
      source text NOT NULL CHECK (source IN ('scheduled','auto','staff_pick')),
      replaces_feature_id uuid REFERENCES daily_features(id),
      active boolean NOT NULL DEFAULT true,
      created_by uuid REFERENCES users(id),
      reason text,
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX daily_features_one_active_per_day ON daily_features (et_date) WHERE active`.execute(
    db,
  );

  await sql`
    CREATE TABLE daily_poll_exceptions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      et_date date NOT NULL,
      kind text NOT NULL CHECK (kind IN ('queue_empty','emergency_removed','emergency_no_replacement')),
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX daily_poll_exceptions_queue_empty ON daily_poll_exceptions (et_date) WHERE kind = 'queue_empty'`.execute(
    db,
  );

  await sql`
    CREATE TABLE notifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id),
      kind text NOT NULL,
      dedupe_key text UNIQUE,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      read_at timestamptz
    )
  `.execute(db);
  await sql`CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of [
    'notifications',
    'daily_poll_exceptions',
    'daily_features',
    'daily_schedule',
    'polls',
    'poll_proposals',
    'pp_ledger',
    'pp_accounts',
  ]) {
    await sql`DROP TABLE ${sql.table(t)}`.execute(db);
  }
  await sql`ALTER TABLE users DROP COLUMN hide_name_on_polls`.execute(db);
  await sql`DROP EXTENSION IF EXISTS pg_trgm`.execute(db);
}
