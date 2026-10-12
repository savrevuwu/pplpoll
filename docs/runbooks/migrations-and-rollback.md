# Migrations and rollback

- Migrations live in `packages/db/src/migrations/` and are registered, in order, in `index.ts`. Never edit or reorder a migration that has run anywhere shared.
- Every migration has `up` and `down`. CI proves `up → down → up` on an empty database (test M0-02).
- Breaking schema changes use **expand → backfill → contract** across separate deploys, so the previous app version keeps working against the new schema.
- **Production rollback = redeploy the previous app version.** Do not run `down` against production data. If a data-destroying rollback is truly needed: take a backup / confirm point-in-time recovery first, get owner approval, then run `pnpm migrate:down` once per step.
- Append-only tables (e.g. `audit.events`) reject UPDATE/DELETE/TRUNCATE at the database level.
