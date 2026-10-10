# Requirements Traceability (PROPOSAL)

Spec clause (V2) → component → tests (IDs in `test-plan.md`). "Status" is honest: nothing is implemented yet.

| Spec § | Requirement (short) | Component | Tests | Status |
|---|---|---|---|---|
| 1 | Survey vs guessing separation; one response per person per poll for life | surveys, games, participation identity | AT-06, AT-08 | Not started |
| 2 | Poll lifecycle; zero-response queue; 00:00 ET debut; never repeat; 100-respondent gate for games only | polls, daily, snapshots | AT-01..04, AT-32 | Not started |
| 2 (edge) | Emergency replacement from fresh queue; empty-queue alert | daily, alerts | AT-02, AT-29 | Not started |
| 3 | ET day boundary + DST; 1+10 = 11 → 1 PP; atomic ledger | time, daily progress, pp_ledger | M0-01, AT-05 | Not started |
| 4 | Free-text, quality gate, semantic grouping, raw privacy, 24 h snapshots | surveys, normalizer, snapshots | AT-06, AT-07, unit normalizer | Not started |
| 5 | 60% goal, 3 strikes, 10–20 cap, duplicates neutral, played on first guess, no list reveal, no poll choice | games domain | AT-08, AT-09, AT-15 | Not started |
| 6 | Solo selection, played persistence, empty state | games/solo | AT-08 | Not started |
| 7 | Modes/minimums, first-available matching, server poll choice, frozen snapshot, spectator limits, block behaviour | matchmaking, match engine | AT-15, AT-19 | Not started |
| 8.1 | Private pauses (2 × 10 min, 51% of others, Ready, final 60 s, kick 100%) | match engine | AT-16 | Not started |
| 8.2 | Disconnect vote, protected wait, Nevermind, 60 s fallback not stacked | match engine | AT-17 | Not started |
| 8.3 | Unanimous vote to continue; no forfeit wins; <3 → no winner | match engine | AT-18 | Not started |
| 8.4 | Technical pause, 60 s Ready, draw | match engine, ops | AT-20 | Not started |
| 9 | Proposals: 1 PP, routes, auto exact-dup reject, refunds, creator notifications, My Polls, anonymity | proposals, pp_ledger, staff | AT-22, AT-25 | Not started |
| 10 | Invites, one account per person, username/display name rules, one-year deactivation | auth, accounts, jobs | AT-21, AT-26, AT-31 | Not started |
| 11 | Profile, picture pipeline + 168 h cooldown, social links, presence | profiles, image worker | AT-21 | Not started |
| 12 | Friends/followers/blocks, DMs/groups limits | social, messaging | AT-24 | Not started |
| 13 | Account states + data classes | lifecycle, all domains | AT-23 | Not started |
| 14 | Staff hierarchy, records, audit | staff, audit | AT-25 | Not started |
| 15 | Reports, urgent routing, escalation, protective measures | reports, cases, jobs | AT-25 | Not started |
| 16 | Cheating investigations suspend guessing; appeals | cases, games guard | AT-25 | Not started |
| 17 | Leaderboards, achievements (retroactive), two streaks | stats | AT-22, AT-28, AT-30 | Not started |
| 18 | Notifications, reminders, user-facing states, no leaks | notifications | AT-15, AT-28 | Not started |
| 19 | Server-side authz, constraints, audit logs, security, state machine, privacy, ops, a11y | all | AT-24, AT-25, AT-27 | Not started |
| 20 | Acceptance tests | test suite | AT-01..27 | Not started |
| 23.1 | K, cap formula, K ≤ 17 gate | domain/eligibility | AT-09, AT-10 | Not started |
| 23.2 | Replay rule | domain/replay | AT-11 | Not started |
| 23.3 | 10 shared charges, reservations, one active game, midnight | allowance ledger | AT-12..14 | Not started |
| 23.4 | Mode minimums, reconnect sequencing | match engine | AT-17..19 | Not started |
| 23.5 | Leaderboards, achievements, streaks | stats | AT-28, AT-30 | Not started |
| 23.6 | Emergency Daily Poll | daily | AT-29 | Not started |
| 23.7 | Deactivation, privacy, data classes | lifecycle | AT-23, AT-31 | Not started |
| 24 | V2 acceptance tests | test suite | AT-10..13, AT-17..19, AT-28..32 | Not started |
