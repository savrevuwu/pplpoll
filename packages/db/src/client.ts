import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

/**
 * Typed table interfaces are added per milestone as tables are created.
 * M0 has only the append-only audit log.
 */
export interface Database {
  'audit.events': {
    id: string;
    occurred_at: Date;
    actor_user_id: string | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    detail: unknown;
  };
}

export function createDb(connectionString: string): Kysely<Database> {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
