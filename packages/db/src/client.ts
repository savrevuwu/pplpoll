import { Kysely, PostgresDialect, type ColumnType, type Generated } from 'kysely';
import pg from 'pg';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;

export type Role = 'member' | 'trainee' | 'moderator' | 'super_moderator' | 'admin' | 'owner';
export type AccountState = 'active' | 'frozen' | 'banned' | 'deactivated' | 'deleted';

export interface Database {
  'audit.events': {
    id: Generated<string>;
    occurred_at: Generated<Date>;
    actor_user_id: string | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    detail: ColumnType<unknown, string | undefined, string>;
  };
  users: {
    id: Generated<string>;
    role: ColumnType<Role, Role | undefined, Role>;
    state: ColumnType<AccountState, AccountState | undefined, AccountState>;
    created_at: Generated<Date>;
  };
  username_reservations: {
    username_key: string;
    user_id: string | null;
    reason: ColumnType<string, string | undefined, string>;
    reserved_at: Generated<Date>;
  };
  profiles: {
    user_id: string;
    username: string;
    display_name: string | null;
    display_name_changed_at: NullableTimestamp;
    created_at: Generated<Date>;
  };
  credentials: {
    user_id: string;
    email_lookup: string;
    email_enc: string;
    password_hash: string;
    email_verified_at: NullableTimestamp;
    created_at: Generated<Date>;
  };
  participation_identities: {
    id: Generated<string>;
    identity_hmac: string;
    created_at: Generated<Date>;
  };
  user_participation_identity: {
    user_id: string;
    participation_identity_id: string;
  };
  email_verification_tokens: {
    token_hash: string;
    user_id: string;
    expires_at: Timestamp;
    used_at: NullableTimestamp;
  };
  invite_codes: {
    id: Generated<string>;
    code_lookup: string;
    code_enc: string;
    label: string | null;
    max_uses: number;
    uses_count: Generated<number>;
    expires_at: NullableTimestamp;
    revoked_at: NullableTimestamp;
    created_by: string;
    created_at: Generated<Date>;
  };
  invite_redemptions: {
    id: Generated<string>;
    invite_id: string;
    user_id: string;
    redeemed_at: Timestamp;
  };
  sessions: {
    id: Generated<string>;
    token_hash: string;
    csrf_token: string;
    user_id: string;
    created_at: Timestamp;
    last_seen_at: Timestamp;
    expires_at: Timestamp;
    revoked_at: NullableTimestamp;
  };
  account_lifecycle: {
    user_id: string;
    generation: number;
    deactivated_at: Timestamp;
    deletion_due_at: Timestamp;
    warning_due_at: Timestamp;
    warning_sent_at: NullableTimestamp;
    reactivated_at: NullableTimestamp;
    deleted_at: NullableTimestamp;
  };
  email_outbox: {
    id: Generated<string>;
    dedupe_key: string;
    kind: string;
    payload_enc: string;
    created_at: Timestamp;
    sent_at: NullableTimestamp;
  };
}

export function createDb(connectionString: string): Kysely<Database> {
  const pool = new pg.Pool({ connectionString, max: 20 });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
