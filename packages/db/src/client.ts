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

export type PpKind = 'daily_award' | 'proposal_debit' | 'proposal_refund' | 'refund_reversal';
export type ProposalStatus = 'pending' | 'approved' | 'rejected';
export type ProposalRoute = 'normal' | 'sensitive' | 'similarity';
export type Visibility = 'public' | 'anonymous';
export type PollStatus = 'queued' | 'live_daily' | 'survey' | 'removed';
type DateOnly = ColumnType<string, string, string>;
type Json = ColumnType<unknown, string | undefined, string>;

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
    hide_name_on_polls: Generated<boolean>;
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
  pp_accounts: {
    user_id: string;
    balance: Generated<number>;
  };
  pp_ledger: {
    id: Generated<string>;
    user_id: string;
    delta: number;
    kind: PpKind;
    ref_id: string | null;
    et_date: DateOnly | null;
    actor_user_id: string | null;
    created_at: Timestamp;
  };
  poll_proposals: {
    id: Generated<string>;
    creator_user_id: string;
    text: string;
    exact_key: string;
    visibility: Visibility;
    status: ColumnType<ProposalStatus, ProposalStatus | undefined, ProposalStatus>;
    route: ProposalRoute;
    idempotency_key: string;
    similar_to: Json;
    refunded: Generated<boolean>;
    decision_reason: string | null;
    decided_by: string | null;
    decided_at: NullableTimestamp;
    created_at: Timestamp;
  };
  polls: {
    id: Generated<string>;
    proposal_id: string | null;
    text: string;
    exact_key: string;
    creator_user_id: string | null;
    creator_visibility: Visibility;
    status: ColumnType<PollStatus, PollStatus | undefined, PollStatus>;
    debut_et_date: ColumnType<string | null, string | null | undefined, string | null>;
    response_count: Generated<number>;
    approved_by: string | null;
    approved_at: Timestamp;
    removed_at: NullableTimestamp;
    removed_reason: string | null;
  };
  daily_schedule: {
    et_date: DateOnly;
    poll_id: string;
    scheduled_by: string;
    scheduled_at: Timestamp;
  };
  daily_features: {
    id: Generated<string>;
    et_date: DateOnly;
    poll_id: string;
    kind: 'primary' | 'emergency_replacement';
    source: 'scheduled' | 'auto' | 'staff_pick';
    replaces_feature_id: string | null;
    active: Generated<boolean>;
    created_by: string | null;
    reason: string | null;
    started_at: Timestamp;
    ended_at: NullableTimestamp;
  };
  daily_poll_exceptions: {
    id: Generated<string>;
    et_date: DateOnly;
    kind: 'queue_empty' | 'emergency_removed' | 'emergency_no_replacement';
    detail: Json;
    created_at: Timestamp;
  };
  notifications: {
    id: Generated<string>;
    user_id: string;
    kind: string;
    dedupe_key: string | null;
    payload: Json;
    created_at: Timestamp;
    read_at: NullableTimestamp;
  };
  survey_responses: {
    id: Generated<string>;
    poll_id: string;
    participation_identity_id: string;
    user_id: string | null;
    et_date: DateOnly;
    context: 'daily_poll' | 'assignment';
    daily_feature_id: string | null;
    assignment_slot: number | null;
    counts_for_progress: boolean;
    normalized_key: string;
    normalization_version: number;
    answer_group_id: string | null;
    status: ColumnType<
      'accepted' | 'removed',
      'accepted' | 'removed' | undefined,
      'accepted' | 'removed'
    >;
    submitted_at: Timestamp;
  };
  survey_response_raw: {
    response_id: string;
    raw_text_enc: string;
  };
  daily_assignments: {
    user_id: string;
    et_date: DateOnly;
    slot: number;
    poll_id: string;
    response_id: string | null;
    created_at: Timestamp;
  };
  streaks: {
    user_id: string;
    kind: 'answering' | 'guessing';
    current: Generated<number>;
    longest: Generated<number>;
    last_et_date: ColumnType<string | null, string | null | undefined, string | null>;
  };
  notification_settings: {
    user_id: string;
    daily_poll_announcement: Generated<boolean>;
    answering_reminder: Generated<boolean>;
    guessing_reminder: Generated<boolean>;
  };
  daily_announcement_seen: {
    user_id: string;
    et_date: DateOnly;
  };
}

// Return SQL `date` columns as 'YYYY-MM-DD' strings (America/New_York business dates), not JS Dates.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export function createDb(connectionString: string): Kysely<Database> {
  const pool = new pg.Pool({ connectionString, max: 20 });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
