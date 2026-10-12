import { sql, type Kysely } from 'kysely';

/**
 * Baseline: extensions and the append-only audit schema (spec §14, §19).
 * Audit rows can be inserted but never updated or deleted, enforced in the database.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db);
  await sql`CREATE SCHEMA audit`.execute(db);
  await sql`
    CREATE TABLE audit.events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      occurred_at timestamptz NOT NULL DEFAULT now(),
      actor_user_id uuid,
      action text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
      target_type text,
      target_id text,
      detail jsonb NOT NULL DEFAULT '{}'::jsonb
    )
  `.execute(db);
  await sql`CREATE INDEX audit_events_target_idx ON audit.events (target_type, target_id, occurred_at)`.execute(
    db,
  );
  await sql`
    CREATE FUNCTION audit.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'audit.% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
    END;
    $$
  `.execute(db);
  await sql`
    CREATE TRIGGER audit_events_append_only
    BEFORE UPDATE OR DELETE ON audit.events
    FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation()
  `.execute(db);
  await sql`
    CREATE TRIGGER audit_events_no_truncate
    BEFORE TRUNCATE ON audit.events
    FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_mutation()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP SCHEMA audit CASCADE`.execute(db);
}
