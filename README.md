# The People Poll

Survey collection + popular-answer guessing game platform.

> **Status:** Milestone 0 (engineering baseline) in progress. No product features exist yet.
> Approved product spec: [`docs/spec/The_People_Poll_Master_Specification_v2.md`](docs/spec/The_People_Poll_Master_Specification_v2.md).

## Quick start

See [docs/runbooks/local-setup.md](docs/runbooks/local-setup.md).

## Planning documents (stack approved 2026-10-12; other proposals under review)

- [Decisions & audit](docs/decisions.md) — contradiction audit, open questions, ADRs
- [Architecture](docs/architecture.md)
- [Data model](docs/data-model.md)
- [Authorization matrix](docs/authorization-matrix.md)
- [State machines](docs/game-state-machine.md)
- [API contracts](docs/api-contracts.md)
- [Test plan](docs/test-plan.md)
- [Requirements traceability](docs/requirements-traceability.md)

## Phased build plan

| Milestone                      | Deliverables                                                                                                                                     | Acceptance gate (objective)                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| **M0 Baseline**                | Monorepo, Postgres/Redis/Mailpit via Docker Compose, migrations framework, ET clock module, structured logger + scrubber, `/health`, CI          | M0-01..05 green in CI; `pnpm install && pnpm test` reproducible from clean clone; migration up/down/up |
| **M1 Identity & audit**        | Invites, registration, email verification, username reservation, display names, sessions, roles, staff audit log, deactivation/reactivation jobs | AT-21 (name part), AT-23 (account part), AT-26, AT-31; role-escalation tests                           |
| **M2 Proposals & Daily Poll**  | PP ledger (debit/refund), proposal queues, zero-response queue, calendar, 00:00 ET publish job, emergency replacement, empty-queue alert         | AT-01..03, AT-29 (queue part), AT-32; publish job idempotent under double-run                          |
| **M3 Surveys & PP**            | Survey submit, quality gate, participation identity, 1+10 assignments, exactly-once PP, answering streak                                         | AT-04..07, AT-28 (answering), AT-29; DST + midnight race tests                                         |
| **M4 Solo guessing**           | Normalizer, answer groups, 24 h snapshots, K/cap/eligibility, replay rule, allowance ledger, solo game, guessing streak                          | AT-08..14, AT-28 (guessing)                                                                            |
| **M5 Multiplayer**             | Matchmaking/rooms, match state machine, WS gateway, spectators, pauses, disconnects, vote-to-continue, outage handling                           | AT-13, AT-15..20 (needs answers to Q1, Q3–Q5)                                                          |
| **M6 Social/moderation/stats** | Profiles, image pipeline, friends/blocks, DMs/groups, reports, staff cases, appeals, leaderboards, achievements                                  | AT-21..25, AT-30                                                                                       |
| **M7 Production readiness**    | Load, security review, a11y, backups/restore drill, runbooks                                                                                     | AT-27; no critical security defects; owner approves beta                                               |

## Milestone 0 — files

```
package.json, pnpm-workspace.yaml, tsconfig.base.json, .nvmrc, .editorconfig, .gitignore, .env.example
eslint.config.js, .prettierrc, vitest.config.ts
docker-compose.yml                     # postgres:16, redis:7, mailpit
.github/workflows/ci.yml               # lint, typecheck, unit, integration (pg service), migrations, gitleaks, audit
packages/domain/src/time.ts            # etDate(), nextEtMidnight(), DST-safe (+ tests)
packages/domain/src/index.ts
packages/db/src/client.ts, migrator.ts
packages/db/src/migrations/0001_baseline.ts  # pgcrypto, append-only audit schema (+ down)
apps/api/src/server.ts, main.ts, routes/health.ts, logger.ts (+ scrubber tests)
apps/worker/src/main.ts                # pg-boss bootstrap only
apps/web/                              # Vite + React shell, accessible layout
docs/runbooks/local-setup.md, docs/runbooks/migrations-and-rollback.md
```
