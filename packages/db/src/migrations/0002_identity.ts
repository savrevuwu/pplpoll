import { sql, type Kysely } from 'kysely';

/**
 * Milestone 1: identity, invites, sessions, account lifecycle, email outbox (spec §10, §13, §14).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      role text NOT NULL DEFAULT 'member'
        CHECK (role IN ('member','trainee','moderator','super_moderator','admin','owner')),
      state text NOT NULL DEFAULT 'active'
        CHECK (state IN ('active','frozen','banned','deactivated','deleted')),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  // Exactly one Owner may exist.
  await sql`CREATE UNIQUE INDEX users_single_owner ON users ((true)) WHERE role = 'owner'`.execute(
    db,
  );

  // Every username ever assigned stays reserved forever (never deleted).
  await sql`
    CREATE TABLE username_reservations (
      username_key text PRIMARY KEY CHECK (username_key ~ '^[a-z0-9]{3,20}$'),
      user_id uuid REFERENCES users(id),
      reason text NOT NULL DEFAULT 'registered',
      reserved_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE TABLE profiles (
      user_id uuid PRIMARY KEY REFERENCES users(id),
      username text NOT NULL CHECK (username ~ '^[A-Za-z0-9]{3,20}$'),
      display_name text CHECK (
        display_name IS NULL OR (
          display_name ~ '^[A-Za-z0-9 ]{1,20}$' AND display_name = btrim(display_name)
          AND btrim(display_name) <> ''
        )
      ),
      display_name_changed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX profiles_username_key ON profiles (lower(username))`.execute(db);

  await sql`
    CREATE TABLE credentials (
      user_id uuid PRIMARY KEY REFERENCES users(id),
      email_lookup text NOT NULL UNIQUE,
      email_enc text NOT NULL,
      password_hash text NOT NULL,
      email_verified_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  // Minimal participation-uniqueness proof; survives account deletion (legal review L1).
  await sql`
    CREATE TABLE participation_identities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      identity_hmac text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`
    CREATE TABLE user_participation_identity (
      user_id uuid PRIMARY KEY REFERENCES users(id),
      participation_identity_id uuid NOT NULL REFERENCES participation_identities(id)
    )
  `.execute(db);

  await sql`
    CREATE TABLE email_verification_tokens (
      token_hash text PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      used_at timestamptz
    )
  `.execute(db);

  await sql`
    CREATE TABLE invite_codes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code_lookup text NOT NULL UNIQUE,
      code_enc text NOT NULL,
      label text CHECK (label IS NULL OR length(label) <= 100),
      max_uses integer NOT NULL CHECK (max_uses >= 1),
      uses_count integer NOT NULL DEFAULT 0 CHECK (uses_count >= 0 AND uses_count <= max_uses),
      expires_at timestamptz,
      revoked_at timestamptz,
      created_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`
    CREATE TABLE invite_redemptions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      invite_id uuid NOT NULL REFERENCES invite_codes(id),
      user_id uuid NOT NULL UNIQUE REFERENCES users(id),
      redeemed_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE TABLE sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      token_hash text NOT NULL UNIQUE,
      csrf_token text NOT NULL,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz
    )
  `.execute(db);
  await sql`CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL`.execute(
    db,
  );

  await sql`
    CREATE TABLE account_lifecycle (
      user_id uuid PRIMARY KEY REFERENCES users(id),
      generation integer NOT NULL CHECK (generation >= 1),
      deactivated_at timestamptz NOT NULL,
      deletion_due_at timestamptz NOT NULL,
      warning_due_at timestamptz NOT NULL,
      warning_sent_at timestamptz,
      reactivated_at timestamptz,
      deleted_at timestamptz,
      CHECK (warning_due_at < deletion_due_at)
    )
  `.execute(db);
  await sql`
    CREATE INDEX account_lifecycle_pending_idx ON account_lifecycle (deletion_due_at)
    WHERE reactivated_at IS NULL AND deleted_at IS NULL
  `.execute(db);

  // Emails are queued in the same transaction as the change that causes them.
  await sql`
    CREATE TABLE email_outbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      dedupe_key text NOT NULL UNIQUE,
      kind text NOT NULL,
      payload_enc text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      sent_at timestamptz
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of [
    'email_outbox',
    'account_lifecycle',
    'sessions',
    'invite_redemptions',
    'invite_codes',
    'email_verification_tokens',
    'user_participation_identity',
    'participation_identities',
    'credentials',
    'profiles',
    'username_reservations',
    'users',
  ]) {
    await sql`DROP TABLE ${sql.table(t)}`.execute(db);
  }
}
