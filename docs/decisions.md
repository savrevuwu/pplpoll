# Decisions and Audit

> **Status:** PROPOSAL awaiting owner review. No application code exists yet in this repository.
> Source of truth: `docs/spec/The_People_Poll_Master_Specification_v2.md` (§§23–24 control on conflict).

## 1. Contradiction and dependency audit

### 1.1 Superseded V1 / Addendum text (resolved by V2 — no action)

| Topic                    | V1 / Addendum                                             | V2 (controls)                                                                                            |
| ------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Voluntary closure        | 30-day pending deletion, explicit cancel, no deactivation | One-year deactivation, auto-reactivate on authenticated sign-in, 30-day-prior warning email (§10, §23.7) |
| Guess cap                | "documented deterministic rule"                           | `min(20, max(10, K+3))`, K ≤ 17 gate (§23.1)                                                             |
| Replay threshold         | "documented measurable threshold"                         | 30 days + ≥120% respondents + (≥5pp top-5 shift OR top-3 order change) (§23.2)                           |
| Multiplayer minimums     | unspecified                                               | Versus = exactly 2; all other modes 3–6 (§23.4)                                                          |
| Emergency replacement PP | "implement fairly"                                        | Original credit preserved; replacement gives no second PP (§23.6)                                        |
| Leaderboards             | formula not specified                                     | Win rate → accuracy → wins; 10-game minimum per mode/period (§23.5)                                      |
| Daily allowance          | Addendum                                                  | Fully restated in §23.3; consistent with Addendum                                                        |

No internal contradiction was found between V2 §§1–22 and §§23–24.

### 1.2 Genuine open product questions (owner must decide — I will not invent these)

| ID     | Question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Why it blocks                                    | Blocks milestone |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------- |
| **Q1** | **ANSWERED by the Game Modes & Statistics Update (2026-10-12)** — modes, formats, scoring and tiebreakers are defined in `docs/spec/The_People_Poll_Game_Modes_Statistics_Update.md`. Follow-up questions G1–G11 are in `docs/impact-game-modes.md`.                                                                                                                                                                                                                                            | Match state machine, leaderboards                | M5               |
| **Q2** | **DECIDED (owner, 2026-10-12): Owner/Admin may add polls with no PP cost; they still go through the same zero-response Daily Poll queue.** **How does the poll pool start?** On launch day there are 0 existing polls, so no one can complete 11 responses (no PP) until ≥10 Daily Polls have aired, and proposals cost PP. Who fills the Daily Poll queue for the first weeks? Proposed: Owner/Admin may author proposals with no PP cost; they still go through the same zero-response queue. | Without a seed path the queue is empty on day 1. | M2               |
| **Q3** | **Is the disconnect reconnect-vote (§8.2) available in public matches?** Public has "no voluntary pauses", and the 2-pause cap is a private-room rule. Proposed: public matches (and pause-quota-exhausted private matches) use only the automatic 60-second grace; private/friends use the vote + protected wait while quota remains.                                                                                                                                                          | Changes match state machine guards.              | M5               |
| **Q4** | **ANSWERED by the update:** Head-to-Head (and Teams) are offered in public matchmaking, private rooms and friend challenges, including Best-of-3/5. Manual pauses stay private/friends only (spec §8.1).                                                                                                                                                                                                                                                                                        | Matchmaking + pause guards                       | M5               |
| **Q5** | **Who may spectate public matches?** Spec: host controls private spectating; "other access must respect mode/privacy". Proposed: friends of a participant (subject to blocks and online-visibility).                                                                                                                                                                                                                                                                                            | Spectator auth rules.                            | M5               |

| **Q6** | **DECIDED (owner, 2026-10-12): English letters only.** Display names allow A–Z, a–z, 0–9 and spaces (as implemented in M1). | Display-name validation | Done |
| **Q7** | **DECIDED (owner, 2026-10-12): frozen accounts can still sign in, but cannot do the specific things they are frozen for.** A freeze therefore carries a list of blocked actions (e.g. messaging, proposing polls, guessing games), enforced server-side on each of those actions; everything else keeps working. Their account content stays hidden from others while frozen (spec §13). Built with moderation in M6; each feature milestone adds its action to the freeze list. | Sign-in rules, freeze model | M6 |

### 1.3 Legal / privacy review dependencies (cannot be resolved by engineering)

- **L1 — Lifetime one-answer-per-poll across deletion (§1, §10, §23.7).** Proposed mechanism: a keyed HMAC of the normalized verified email (`participation_identity`), stored separately from the account and retained after deletion. A person with a _new_ email cannot be reliably linked without stronger identity proof; spec forbids IP/device alone as proof. Needs legal review of lawful basis and retention.
- **L2 — Retention periods** for evidence, backups, raw survey text, audit logs. Spec forbids inventing durations; tables carry a `retention_class` and jobs read periods from config that legal fills in.
- **L3 — Staff DM access** requires a documented investigation authorization process.
- **L4 — Early verified privacy deletion** path and its exceptions.
- **L5 — Age / underage policy** (report category exists; no minimum age is stated). Flag for legal.

### 1.4 Engineering choices (I decide these; listed for transparency, not as product questions)

- Day boundary computed with IANA `America/New_York`; all dates stored as ET `date` plus UTC `timestamptz`.
- Snapshot job runs daily at 00:15 ET (after Daily Poll publication at 00:00 ET).
- Answer grouping: deterministic versioned normalizer (case, Unicode NFKC, punctuation, whitespace, simple plural/singular) + staff-curated alias merges per poll. Optional ML/LLM merge _suggestions_ only, always staff-approved and frozen into a versioned alias table so results are reproducible.
- Survey uniqueness index covers `accepted` **and** `removed_by_moderation` responses (removal must not open a second answer); quality rejections at submit time do not consume the slot.
- Leaderboard weeks: Monday 00:00 ET; months: calendar month ET.
- Cross-midnight first guess with no new-day allowance: guess is rejected (not stored), participation is ended as `released_no_charge` with a clear message; in multiplayer this is treated as a voluntary-style exit **without** forfeit penalty, triggering the normal Vote-to-Continue path for others.
- HEIC/HEIF decoding needs libheif; the image worker image ships its own libvips/libheif build, isolated in a sandboxed worker with CPU/memory/time caps.

### 1.5 Milestone 1 engineering choices

- Email must be verified before first sign-in. Invite is consumed when the account is created (before verification).
- Passwords: 10–128 characters, Argon2id. Sessions: HttpOnly SameSite=Lax cookie, 30-day sliding expiry, CSRF token header on every state change.
- Emails, invite codes and email payloads are AES-256-GCM encrypted at rest; lookups use keyed HMACs. Invite codes stay copyable by the Owner (spec: "copy, revoke, monitor").
- Deactivation revokes every session, so token refresh or passive visits can never reactivate; only `POST /auth/login` does.
- Deletion deadline = 12:00 AM ET on the day after the one-year anniversary (never less than a year); warning exactly 30 calendar days earlier. Feb 29 anniversaries fall on Mar 1.
- Final deletion removes credentials, profile, sessions and tokens; keeps the username reservation, the participation-uniqueness record and audit history (legal review L1/L2).
- The Owner account cannot deactivate itself (would leave nobody able to promote or issue invites).
- Display-name removal counts as a change for the 168-hour timer. Staff-required corrections (exempt from the timer) arrive with moderation in M6.
- Brute-force protection: per-client rate limits on invite check, register, verify, login. Per-account lockout to be added with M7 security review.

### 1.6 Milestone 2 engineering choices

- **DECIDED (owner, 2026-10-12, R1): proposals never go back to the submitter.** Staff either approve (fixing the wording themselves when needed) or reject. There is no "request revision" action; spec §9's "request revision" is read as staff revising it themselves.
- Exact duplicates are checked against every existing poll and every pending proposal; auto-rejected and refunded. Similar questions (pg_trgm similarity ≥ 0.6) go to the similarity queue with the matches listed for staff.
- Sensitive-queue routing uses a short editable word list (`packages/domain/src/polls.ts`). It only picks a queue; staff decide and can move proposals.
- Rejection reasons decide refunds server-side: good-faith (duplicate, quality, unsuitable for gameplay, other) refund; prohibited/malicious/abusive/spam do not. Super Moderators and above can correct a refund.
- Moderators and above review proposals; trainees do not yet (trainee-with-supervisor flow comes with M6 staff wings).
- Proposal submission needs an `Idempotency-Key`; at most 10 submissions per hour per person.
- Staff may correct wording only while a poll is still queued with zero responses; after its debut, rewording means a new poll.
- Owner/Admin-seeded polls (decision Q2) default to anonymous attribution.
- The publish job runs every minute and is a no-op once today is published, so a late or restarted worker catches up. If the worker starts mid-day with nothing published yet, it publishes for that day.
- Removing the active Daily Poll without a replacement leaves the day "unavailable"; the midnight job does not fill it later that day.
- The per-user daily in-app Daily Poll announcement and its setting arrive with M3 (answering).

### 1.7 Milestone 3 engineering choices

- One answer per person per poll is enforced by a unique index on (poll, participation identity), so deleted-and-recreated accounts can't answer again (legal review L1 still applies).
- A database trigger refuses survey answers for polls that are queued or removed: an approved poll can't be answered before its Daily Poll debut.
- Answer quality gate (deterministic): rejects empty, too long (80+), links/emails, non-answers ("idk", "n/a", "asdf"…), repeated-letter and keyboard-mash text, and owner-configurable blocked words (starts empty; staff removal comes in M6). A rejected answer doesn't use up the person's one answer.
- Raw answers are encrypted in a separate table; gameplay uses a normalized key (lowercase, no punctuation, no leading a/an/the/my/some, versioned). Synonym/plural grouping comes with answer groups in M4.
- The 10 regular surveys are picked at random from existing surveys the person never answered, fixed for the day, and topped up on later visits if new ones become available. A smaller pool means fewer surveys and no PP that day.
- Clients send the poll id they were shown; after 12:00 AM ET (or an emergency swap) the server answers `DAY_ROLLED_OVER` instead of silently crediting a different day or poll.
- All answering for one person and day is serialized with a lock, so the 11th answer awards exactly one PP even when answers arrive at the same moment.
- Daily Poll announcement is on by default and shows until seen that day; answering/guessing reminders are off by default ("optional") and disappear once the day's target is met.
- Answering streak visibility settings (Everyone/Friends/Nobody) are applied with profiles in M6; today only the owner can see their own streaks.
- Per-person limit: 60 answer submissions per minute.

### 1.8 Milestone 4 engineering choices

- **Grouping:** answers with the same normalized key count together; a plural folds into its singular when both were answered ("keys" → "key"); staff (moderator+) can merge synonyms/spellings, applied at the next snapshot. Group labels are the canonical key, capitalized (raw answers stay private).
- **Guess matching:** exact key, plural variant, or one typo/adjacent swap for 5+ letter words — only when exactly one answer group is that close.
- **Snapshots:** one immutable snapshot per poll per ET day (job runs every 10 minutes, idempotent). A game keeps the snapshot it started with. Eligible = 100+ respondents and K ≤ 17.
- **Allowance:** starting reserves (no charge); the first accepted guess charges the ET date of that guess. If that day is already full (only possible across midnight), the guess is refused and the game is released with no charge and the poll is not marked played. Leaving before any accepted guess releases the reservation.
- **Solo outcome:** reaching 60% wins; 3rd strike or using all guesses loses. **DECIDED (owner, S1):** a solo game can't be abandoned after the first accepted guess — it stays saved and the player resumes it later (any day). Leaving is only possible before the first guess, which releases it with no charge. While a game is saved, it is the person's one active game.
- **Rarest Correct Guess:** lowest frozen share among correct guesses from won/lost (completed, valid) games; sitewide badge = everyone tied at the lowest share. Only percentages are shown, never the poll or answer.
- Guess submissions share the per-person 60/min limit; guesses are stored with an identity sequence so same-millisecond guesses replay in exact order.

## 2. Architecture decision records

| ADR     | Decision                                                                                                        | Status   |
| ------- | --------------------------------------------------------------------------------------------------------------- | -------- |
| ADR-001 | TypeScript monorepo (pnpm workspaces): `apps/api`, `apps/web`, `apps/worker`, `packages/domain`, `packages/db`  | Approved |
| ADR-002 | PostgreSQL 16 is the single source of truth; all quotas/uniqueness enforced by constraints + transactions       | Approved |
| ADR-003 | Fastify HTTP API + WebSocket gateway; Redis only for pub/sub fan-out & presence (never authoritative)           | Approved |
| ADR-004 | Background jobs via `pg-boss` (Postgres-backed, transactional enqueue, singleton keys for idempotency)          | Approved |
| ADR-005 | SQL migrations via Kysely migrator, every migration has `down`; expand/contract for breaking changes            | Approved |
| ADR-006 | Pure game/eligibility math in `packages/domain` with no I/O, 100% unit-tested                                   | Approved |
| ADR-007 | Web client: React + Vite SPA (mobile-first, PWA-ready); no server-side secrets in client                        | Approved |
| ADR-008 | Tests: Vitest; integration tests against real Postgres (Docker / CI service), no DB mocks for concurrency tests | Approved |
| ADR-009 | Auth: email + password (Argon2id), server-side session cookies (HttpOnly, SameSite=Lax, CSRF token)             | Approved |

Stack approved by the owner on 2026-10-12. Settled product decisions from the spec are **not** reopened here.
