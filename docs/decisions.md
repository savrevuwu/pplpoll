# Decisions and Audit

> **Status:** PROPOSAL awaiting owner review. No application code exists yet in this repository.
> Source of truth: `docs/spec/The_People_Poll_Master_Specification_v2.md` (§§23–24 control on conflict).

## 1. Contradiction and dependency audit

### 1.1 Superseded V1 / Addendum text (resolved by V2 — no action)

| Topic | V1 / Addendum | V2 (controls) |
|---|---|---|
| Voluntary closure | 30-day pending deletion, explicit cancel, no deactivation | One-year deactivation, auto-reactivate on authenticated sign-in, 30-day-prior warning email (§10, §23.7) |
| Guess cap | "documented deterministic rule" | `min(20, max(10, K+3))`, K ≤ 17 gate (§23.1) |
| Replay threshold | "documented measurable threshold" | 30 days + ≥120% respondents + (≥5pp top-5 shift OR top-3 order change) (§23.2) |
| Multiplayer minimums | unspecified | Versus = exactly 2; all other modes 3–6 (§23.4) |
| Emergency replacement PP | "implement fairly" | Original credit preserved; replacement gives no second PP (§23.6) |
| Leaderboards | formula not specified | Win rate → accuracy → wins; 10-game minimum per mode/period (§23.5) |
| Daily allowance | Addendum | Fully restated in §23.3; consistent with Addendum |

No internal contradiction was found between V2 §§1–22 and §§23–24.

### 1.2 Genuine open product questions (owner must decide — I will not invent these)

| ID | Question | Why it blocks | Blocks milestone |
|---|---|---|---|
| **Q1** | **How is a multiplayer match won?** Spec defines the 60% goal, strikes and cap per player, and that opponents can't see each other's words, but not: are boards parallel (each player guesses alone) or shared/turn-based? Who wins — first to 60%, highest % when all finish, or all who reach 60%? What happens on a tie, or if nobody reaches 60% (all lose = "completed competitive game" with no winner)? Is there a per-guess or per-match time limit? | Leaderboard win rate, Versus outcome, spectator feed and the whole match state machine depend on it. | M5 (and M6 leaderboards) |
| **Q2** | **How does the poll pool start?** On launch day there are 0 existing polls, so no one can complete 11 responses (no PP) until ≥10 Daily Polls have aired, and proposals cost PP. Who fills the Daily Poll queue for the first weeks? Proposed: Owner/Admin may author proposals with no PP cost; they still go through the same zero-response queue. | Without a seed path the queue is empty on day 1. | M2 |
| **Q3** | **Is the disconnect reconnect-vote (§8.2) available in public matches?** Public has "no voluntary pauses", and the 2-pause cap is a private-room rule. Proposed: public matches (and pause-quota-exhausted private matches) use only the automatic 60-second grace; private/friends use the vote + protected wait while quota remains. | Changes match state machine guards. | M5 |
| **Q4** | **1v1 Versus: public, private, or both? Do manual pauses apply?** Proposed: Versus has public queue + friend challenge; manual pauses only in the friend/private variant (same as other modes). | Matchmaking + pause guards. | M5 |
| **Q5** | **Who may spectate public matches?** Spec: host controls private spectating; "other access must respect mode/privacy". Proposed: friends of a participant (subject to blocks and online-visibility). | Spectator auth rules. | M5 |

### 1.3 Legal / privacy review dependencies (cannot be resolved by engineering)

- **L1 — Lifetime one-answer-per-poll across deletion (§1, §10, §23.7).** Proposed mechanism: a keyed HMAC of the normalized verified email (`participation_identity`), stored separately from the account and retained after deletion. A person with a *new* email cannot be reliably linked without stronger identity proof; spec forbids IP/device alone as proof. Needs legal review of lawful basis and retention.
- **L2 — Retention periods** for evidence, backups, raw survey text, audit logs. Spec forbids inventing durations; tables carry a `retention_class` and jobs read periods from config that legal fills in.
- **L3 — Staff DM access** requires a documented investigation authorization process.
- **L4 — Early verified privacy deletion** path and its exceptions.
- **L5 — Age / underage policy** (report category exists; no minimum age is stated). Flag for legal.

### 1.4 Engineering choices (I decide these; listed for transparency, not as product questions)

- Day boundary computed with IANA `America/New_York`; all dates stored as ET `date` plus UTC `timestamptz`.
- Snapshot job runs daily at 00:15 ET (after Daily Poll publication at 00:00 ET).
- Answer grouping: deterministic versioned normalizer (case, Unicode NFKC, punctuation, whitespace, simple plural/singular) + staff-curated alias merges per poll. Optional ML/LLM merge *suggestions* only, always staff-approved and frozen into a versioned alias table so results are reproducible.
- Survey uniqueness index covers `accepted` **and** `removed_by_moderation` responses (removal must not open a second answer); quality rejections at submit time do not consume the slot.
- Leaderboard weeks: Monday 00:00 ET; months: calendar month ET.
- Cross-midnight first guess with no new-day allowance: guess is rejected (not stored), participation is ended as `released_no_charge` with a clear message; in multiplayer this is treated as a voluntary-style exit **without** forfeit penalty, triggering the normal Vote-to-Continue path for others.
- HEIC/HEIF decoding needs libheif; the image worker image ships its own libvips/libheif build, isolated in a sandboxed worker with CPU/memory/time caps.

## 2. Architecture decision records

| ADR | Decision | Status |
|---|---|---|
| ADR-001 | TypeScript monorepo (pnpm workspaces): `apps/api`, `apps/web`, `apps/worker`, `packages/domain`, `packages/db` | Proposed |
| ADR-002 | PostgreSQL 16 is the single source of truth; all quotas/uniqueness enforced by constraints + transactions | Proposed |
| ADR-003 | Fastify HTTP API + WebSocket gateway; Redis only for pub/sub fan-out & presence (never authoritative) | Proposed |
| ADR-004 | Background jobs via `pg-boss` (Postgres-backed, transactional enqueue, singleton keys for idempotency) | Proposed |
| ADR-005 | SQL migrations via Kysely migrator, every migration has `down`; expand/contract for breaking changes | Proposed |
| ADR-006 | Pure game/eligibility math in `packages/domain` with no I/O, 100% unit-tested | Proposed |
| ADR-007 | Web client: React + Vite SPA (mobile-first, PWA-ready); no server-side secrets in client | Proposed |
| ADR-008 | Tests: Vitest; integration tests against real Postgres (Docker / CI service), no DB mocks for concurrency tests | Proposed |
| ADR-009 | Auth: email + password (Argon2id), server-side session cookies (HttpOnly, SameSite=Lax, CSRF token) | Proposed |

Settled product decisions from the spec are **not** reopened here.
