# THE PEOPLE POLL — CLAUDE BUILD HANDOFF
**Prepared:** October 10, 2026  
**Status:** Product specification ready for engineering design; no application code has been built or tested in this handoff.

## Read first
1. `The_People_Poll_Master_Specification_v2.md` — authoritative approved product behavior. Sections 23–24 give precise later decisions and acceptance cases; these control if older wording conflicts.
2. `The_People_Poll_Master_Specification.md` — preserved original Version 1, for traceability only.
3. `The_People_Poll_Daily_Gameplay_Addendum.md` — preserved prior decision record, for traceability only.

**Project boundary:** The People Poll is a survey collection + guessing game platform. Do not mix it with any dating app, fragrance, or other project. Do not add product features, weaken requirements, or reopen settled choices without identifying a real conflict or impossibility.

## Your first response to the owner
Inspect the supplied files and, if available, the actual code repository. Produce:
- A concise contradiction and dependency audit, distinguishing genuine unresolved issues from engineering implementation choices.
- A recommended stack and system architecture, clearly marked as a proposal until approved; first inspect any existing repository and honor its stack if viable.
- A phased build plan with deliverables and objective acceptance gates.
- An initial database/entity model, permission matrix, and server-authoritative state machines for daily surveys, game participation, and multiplayer.
- The exact first implementation milestone and files you will create or change.

Do not claim the app is already built. Do not produce an unreviewable one-shot code dump. After owner approval of architecture or when given an existing repository, implement the first milestone with real tests and report results.

## Recommended implementation sequence

### Milestone 0 — Repo and engineering baseline
- Inspect existing repo, runtime, deployment target, available services, and environment configuration. If no repo, propose an appropriate stack with reasons.
- Define development, staging, production environment boundaries; migrations; CI; secrets management; structured logging; test harness.
- Create a requirements-to-tests traceability matrix covering every numbered specification section, especially §§23–24.
- **Gate:** reproducible local setup, CI, baseline security checks, documented migrations and rollback strategy.

### Milestone 1 — Identity, authorization, and audit
- Invite-only signup, email verification, identity/account constraints, unique permanent username reservation, display-name rules, role hierarchy, staff audit log.
- Authentication and session hardening; account-state data model, including one-year deactivation with authenticated reactivation and 30-day-prior warning.
- **Gate:** concurrent invite redemption, duplicate account controls, role escalation prevention, reactivation/deletion scheduler tests.

### Milestone 2 — Poll proposals and Daily Poll lifecycle
- Proposal PP debit/refund ledger, moderation queues, zero-response approval queue, schedule and auto-selection, America/New_York midnight publication, emergency replacement.
- **Gate:** never feature an answered poll as new; idempotent midnight job; empty-queue alert; preserve emergency replacement credit.

### Milestone 3 — Survey answering and PP progress
- One accepted survey response per person/poll, semantic answer normalization with raw-answer privacy, daily 1+10 assignments, exact-once 1 PP reward, independent answering streak.
- **Gate:** concurrency, retry, daylight-saving, pool-exhaustion, account re-registration, and no synthetic votes.

### Milestone 4 — Solo guessing and eligibility
- Versioned 24-hour snapshots, minimum 100 genuine respondents, K≤17 gate and `min(20,max(10,K+3))` cap, 60% goal, 3 strikes, neutral duplicate guesses, played/replay rules.
- Shared daily 10-charge ledger and guessing streak, including reservations and midnight crossing.
- **Gate:** K boundary tests, frozen snapshot reproducibility, first accepted guess charge, replay triple gate, no answer leaks.

### Milestone 5 — Multiplayer
- Dedicated 2-player Versus and 3–6-player other modes, automatic mutually eligible poll, server-authoritative match state machine, spectators, manual/disconnect/technical pauses, ready checks, unanimous continue votes.
- **Gate:** one active game across devices, exactly-once game charge, 60-second fallback not stacked, 3-player minimum after forfeits, no-winner/technical-draw treatment, reconnect/race tests.

### Milestone 6 — Social, moderation, statistics
- Profiles, image-processing pipeline and 168-hour cooldown, friends/followers/blocks, DMs/group chat, staff reports/appeals and evidence boundaries.
- Weekly/monthly/all-time solo and multiplayer leaderboards, retroactive milestone achievements, separate privacy and reminders for both streaks.
- **Gate:** block/privacy API tests, moderation access audits, ranking math and exclusion of aborted matches, profile picture validation.

### Milestone 7 — Production readiness and beta
- Performance/load testing, security review, accessibility, incident recovery, backups and restore drills, data-retention/legal review, observability, beta runbooks.
- **Gate:** no critical security defects, test suite green, restoration proven, owner approves invite-only beta.

## Cross-cutting invariants — never compromise
- Survey answering and guessing are different systems. No guessed words/secret answer lists leak to other participants or spectators.
- Daily Polls are never previously answered. New polls first debut with zero responses.
- All account quotas, PP balances, survey uniqueness, first guesses, and match transitions are enforced atomically by the server.
- Exactly one charged guessing participation per first accepted guess, shared across solo/multiplayer, at most ten per America/New_York date.
- Replays require ≥30 days, ≥20% genuine respondent growth, and a qualifying distribution change.
- Two independent streaks; no-win aborted matches do not affect competitive leaderboard records.
- Deactivation hides account-associated content; legitimate aggregate survey answers remain subject to lawful retention and deletion rules.
- Permissions are enforced at API and event layers, not only by UI.

## Required engineering artifacts
- `docs/architecture.md`: component diagram, trust boundaries, data flows, jobs, snapshot pipeline.
- `docs/requirements-traceability.md`: spec clause → endpoint/component → tests.
- `docs/data-model.md`: schema, constraints, indices, retention classes, deletion/reactivation lifecycle.
- `docs/authorization-matrix.md`: public/member/moderator/trainee/super-mod/admin/owner permissions.
- `docs/game-state-machine.md`: events, guards, timers, idempotency, recovery and terminal outcomes.
- `docs/api-contracts.md`: HTTP and real-time events, errors, privacy and rate limits.
- `docs/test-plan.md`: unit/integration/e2e/security/load, with spec §§20 and 24 as acceptance baseline.
- `docs/decisions.md`: architectural decisions and explicitly unresolved issues; do not reclassify settled product decisions as open.

## Claude starter prompt (paste with these files attached)
> You are the lead engineer for **The People Poll**. Read `The_People_Poll_Master_Specification_v2.md` in full; it is the approved source of truth. Read `CLAUDE_START_HERE_The_People_Poll.md` for the handoff and the other two files only for historical traceability. First inspect my repository if I provide one; do not assume code exists. Perform a concise contradiction/dependency audit and propose the architecture, schema, state machines, authorization model, phased milestones, and traceability-based test plan. Do not reopen settled product choices or silently change behavior. Flag only genuine conflicts, legal/privacy review dependencies, or technical impossibilities. Then implement incrementally in reviewable, tested milestones, reporting exactly what was changed and what tests actually ran. Start with Milestone 0 and tell me the one concrete action you need from me, if any.

## Handoff note
The files are requirements and planning documents, not proof of a functioning product. Production deployment, legal compliance, and abuse defenses require implementation and independent validation.
