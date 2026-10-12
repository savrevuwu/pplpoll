# Architecture (PROPOSAL)

> Proposal until the owner approves. Repository was empty at inspection (no existing stack to honor).

## 1. Recommended stack and why

| Layer     | Choice                                                                                                                  | Reason                                                                                                   |
| --------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Language  | TypeScript (Node.js 22 LTS) everywhere                                                                                  | One language for API, real-time, jobs, web; shared validated types                                       |
| Database  | PostgreSQL 16                                                                                                           | Unique/partial indexes, CHECK constraints, row locks, SERIALIZABLE — the spec's atomic quotas need these |
| API       | Fastify + Zod schemas                                                                                                   | Fast, schema-validated input (blocks mass assignment), good WebSocket plugin                             |
| Real-time | WebSocket gateway in API process; Redis pub/sub for fan-out across instances                                            | Match events must reach all players/spectators; Redis is a relay only, Postgres stays authoritative      |
| Jobs      | pg-boss on Postgres                                                                                                     | Jobs enqueued in the same transaction as data; singleton keys make midnight/snapshot jobs idempotent     |
| Web       | React + Vite SPA, accessible component library                                                                          | Mobile-responsive, keyboard/screen-reader support                                                        |
| Images    | Separate worker using sharp/libvips + libheif, sandboxed                                                                | Untrusted uploads never decoded in the API process                                                       |
| Email     | Transactional provider (e.g. Postmark or AWS SES) behind an interface                                                   | Verification + deactivation warning only                                                                 |
| Hosting   | Container platform (e.g. Fly.io / Render / AWS ECS) + managed Postgres with PITR + managed Redis                        | Owner to choose; code stays host-agnostic                                                                |
| CI        | GitHub Actions: lint, typecheck, unit, integration (Postgres service), migration up/down, secret scan, dependency audit |                                                                                                          |

## 2. Components and trust boundaries

```
 [Browser SPA] --HTTPS (cookie+CSRF)--> [API (Fastify)] ----> [PostgreSQL]  (authoritative)
       |                                   |   ^                   ^
       +--WSS (session-authenticated)----> [WS Gateway] <--> [Redis pub/sub/presence] (non-authoritative)
                                           |                       |
                                     [Job runner (pg-boss)] -------+
                                     - daily publication 00:00 ET
                                     - daily snapshot 00:15 ET
                                     - deactivation warnings / final deletion
                                     - match timers & escalation deadlines
                                     [Image worker] (sandboxed, no DB write except result row)
                                     [Email provider] (outbound only)
```

Trust boundaries:

1. **Client → API/WS:** everything untrusted. Server ignores client role, PP, guess counts, snapshot IDs, poll IDs for game selection, timers.
2. **API → DB:** least-privilege DB roles: `app_rw` (normal), `app_audit_append` (INSERT-only on audit tables), `app_restricted` (raw survey text, evidence; used only by staff endpoints with access logging).
3. **Image worker:** receives an object-storage key, returns processed image; no network egress except storage.
4. **Staff surfaces:** same API, separate route prefix `/staff/*`, every call rank-checked and audit-logged.

## 3. Key data flows

### 3.1 Daily Poll publication (00:00 ET)

Job `daily.publish` (singleton key = ET date) → in one transaction: pick scheduled poll for date, else auto-select oldest eligible `queued` poll with 0 responses → set `polls.status = live_daily`, insert `daily_features` row (unique per date and per poll) → previous day's live poll → `survey`. If queue empty: insert `daily_poll_exceptions`, alert staff, users see "Daily Poll unavailable".

### 3.2 Survey answer

`POST /surveys/{assignmentId}/responses` → validate text → quality gate → transaction: insert `survey_responses` (unique on poll + participation identity) → mark assignment complete → if 11/11 and no award today, insert PP ledger row (unique per user+date) and streak update → commit → "Thank you for your response".

### 3.3 Snapshot pipeline (every 24h, 00:15 ET)

For each poll with status `survey`/`live_daily`: count accepted responses by answer group using normalization version N → compute K, cap, eligible → insert immutable `result_snapshots` row (poll, version). Games bind to a snapshot ID at start and never change it.

### 3.4 Guessing game

Start → server picks eligible unplayed (or replay-eligible) poll for every participant → reserve allowance per participant → first accepted guess: charge allowance (ET date of guess) + mark played, atomically → game ends → release reservations with no accepted guess.

## 4. Jobs (all idempotent, keyed)

| Job                            | Schedule     | Idempotency key                    |
| ------------------------------ | ------------ | ---------------------------------- |
| `daily.publish`                | 00:00 ET     | ET date                            |
| `snapshot.compute`             | 00:15 ET     | ET date + poll                     |
| `daily.queue_health`           | hourly       | hour; alerts if queue < 7 days     |
| `account.deactivation_warning` | daily        | user + lifecycle generation        |
| `account.final_deletion`       | daily        | user + lifecycle generation        |
| `match.timer`                  | per timer    | match + state_version + timer kind |
| `staff.escalation`             | every 15 min | case + escalation level            |
| `streak.close_day`             | 00:05 ET     | ET date                            |

## 5. Observability and operations

Structured JSON logs (pino) with a scrubber (no raw answers, guesses, emails, tokens). Metrics + alerts: empty Daily Poll queue, publication/snapshot job late, stuck matches, PP issuance anomalies, upload abuse, staff escalation deadlines. Backups: managed PITR + nightly logical dump; quarterly restore drill (M7 gate).
