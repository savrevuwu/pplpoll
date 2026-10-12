# Test Plan (PROPOSAL)

Acceptance baseline: spec §20 ("non-negotiable acceptance tests") and §24 ("additional acceptance tests for Version 2"). Each test ID below is referenced from `requirements-traceability.md`.

## Layers

| Layer       | Tool                                                  | Scope                                                                                                |
| ----------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Unit        | Vitest                                                | `packages/domain`: ET day math, K/cap, eligibility, replay, quorum, leaderboard ordering, normalizer |
| Integration | Vitest + real Postgres 16 (Docker/CI service)         | Constraints, transactions, idempotency, concurrency (parallel connections), jobs                     |
| API / WS    | Vitest + Fastify inject + ws client                   | Authorization on every route/event, error privacy                                                    |
| E2E         | Playwright (Chromium preinstalled)                    | Critical user journeys, accessibility (axe)                                                          |
| Security    | gitleaks, `pnpm audit`, ZAP baseline (M7), authz fuzz |                                                                                                      |
| Load        | k6 (M7)                                               | Midnight spike, matchmaking, snapshot job                                                            |

Concurrency tests run N parallel transactions (N ≥ 20) against the same row and assert the invariant (e.g. exactly one PP row).
Time tests use an injectable clock and real `America/New_York` tz data, including DST days (2nd Sunday March, 1st Sunday November).

## Acceptance tests (§20 + §24)

| ID    | Test                                                                                                                                     | Milestone |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| AT-01 | Approved question cannot collect a response before its Daily Poll debut; no bypass of queue                                              | M2        |
| AT-02 | A poll is never featured twice (unique feature); empty queue → unavailable state + alert, no recycle                                     | M2        |
| AT-03 | Daily Poll starts at zero; prior Daily Poll becomes survey at next 00:00 ET                                                              | M2        |
| AT-04 | 100-respondent gate affects guessing only                                                                                                | M3/M4     |
| AT-05 | 11 distinct eligible responses → exactly 1 PP with retries + midnight race; ≤10 → 0 PP                                                   | M3        |
| AT-06 | One permanent response per person/poll incl. 20 concurrent submits and delete+re-register                                                | M3        |
| AT-07 | No synthetic votes path exists (no API/job inserts responses except user submission)                                                     | M3        |
| AT-08 | Solo never counts toward daily survey quota; view/answer never marks played; first accepted guess does                                   | M4        |
| AT-09 | 60% goal, 3rd strike loss, cap = min(20,max(10,K+3)), duplicate neutrality                                                               | M4        |
| AT-10 | K=17 → cap 20; K=18 → survey-only, eligible later when K drops                                                                           | M4        |
| AT-11 | Replay requires 30 d + ≥120% respondents + (≥5pp top-5 shift or top-3 order change); top-5 membership change alone fails                 | M4        |
| AT-12 | Game started 23:55 ET, first guess 00:01 → charged to new date once; no guess → released                                                 | M4        |
| AT-13 | 10 charges across solo+multi block an 11th new game; in-progress game may finish                                                         | M4/M5     |
| AT-14 | One active game across devices/tabs (concurrent starts)                                                                                  | M4        |
| AT-15 | Frozen snapshot identical for all match participants; no answer leak to opponents/spectators (API + WS payload scan)                     | M5        |
| AT-16 | Private pause quorum (51% of others), 2-pause cap, failed votes don't count, Ready gating                                                | M5        |
| AT-17 | Disconnect vote + protected 60 s wait; Nevermind disabled during protection; 60 s fallback never stacked                                 | M5        |
| AT-18 | 3-player match → 2 after protection: ends no winner; 4 → 3: unanimous continue vote + Ready needed                                       | M5        |
| AT-19 | Two-person private normal match cannot start; Versus can; public has no voluntary pause                                                  | M5        |
| AT-20 | Outage → tech pause → 60 s Ready → resume or draw; no pause quota used; no forfeit wins anywhere                                         | M5        |
| AT-21 | Display-name and photo 168 h timers exact; photo removal doesn't restart timer; username permanently reserved                            | M1/M6     |
| AT-22 | Global/per-poll anonymity restore; leaderboard Anonymous keeps rank and score                                                            | M6        |
| AT-23 | Frozen/banned/deactivated content hidden; poll questions + aggregates persist                                                            | M1/M6     |
| AT-24 | Blocked user can't reach protected data via direct APIs, cached feeds, DMs, mentions, alt endpoints                                      | M6        |
| AT-25 | Staff rank/conflict/escalation/audit/refund/evidence/cheating rules server-side                                                          | M6/M7     |
| AT-26 | Invites redeemed atomically only on successful registration; expiry/revocation/use caps (concurrent)                                     | M1        |
| AT-27 | Backup restore succeeds; jobs resume safely; logs contain no secrets/response text                                                       | M7        |
| AT-28 | Streaks update only on 11+PP / 10-charge thresholds; independent privacy + reminders                                                     | M3/M4/M6  |
| AT-29 | Emergency replacement only from fresh queue; prior completion kept; replacement can't give 2nd PP                                        | M2/M3     |
| AT-30 | Leaderboards exclude aborted games + duplicates; 10 completed games per mode/period; sort win rate → accuracy → wins                     | M6        |
| AT-31 | Deactivation warning exactly 30 d before one-year deadline; interactive sign-in cancels; token refresh doesn't; re-deactivation restarts | M1        |
| AT-32 | Reworded poll restarts as a distinct zero-response proposal                                                                              | M2        |

## Milestone 0 baseline tests

| ID    | Test                                                                                        |
| ----- | ------------------------------------------------------------------------------------------- |
| M0-01 | `etDate(instant)` correct around both DST transitions and at 23:59:59.999 / 00:00:00.000 ET |
| M0-02 | Migrations run `up → down → up` cleanly on empty DB                                         |
| M0-03 | `/health` returns 200 and DB connectivity                                                   |
| M0-04 | Logger scrubber removes emails, tokens, `text`/`answer`/`guess` fields                      |
| M0-05 | CI: lint, typecheck, tests, gitleaks, dependency audit all green                            |
