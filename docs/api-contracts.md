# API & Real-time Contracts (PROPOSAL — outline)

Conventions: JSON over HTTPS; session cookie + `X-CSRF-Token` on mutations; `Idempotency-Key` header required on every mutation that changes PP, responses, allowances, or match state. Errors: `{ "error": { "code": "STRING_CODE", "message": "safe text" } }` — never include answers, distributions, other users' data, or moderation details. All inputs validated with Zod; unknown fields rejected (mass-assignment protection). Rate limits per account + per IP (IP never used as identity proof).

## Auth & account (M1)

| Method     | Path                  | Notes / errors                                                                                                                      |
| ---------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| POST       | `/auth/invite/check`  | `{code}` → `{valid}`; brute-force limited; does not consume                                                                         |
| POST       | `/auth/register`      | `{code, email, password, username}`; atomic consume on success; `INVITE_INVALID`, `USERNAME_TAKEN` (incl. reserved), `EMAIL_IN_USE` |
| POST       | `/auth/verify-email`  | token                                                                                                                               |
| POST       | `/auth/login`         | interactive sign-in; **reactivates deactivated account**                                                                            |
| POST       | `/auth/refresh`       | background refresh; **never reactivates**                                                                                           |
| POST       | `/auth/logout`        |                                                                                                                                     |
| POST       | `/account/deactivate` | starts new one-year period                                                                                                          |
| PATCH      | `/me/profile`         | display name (168 h rule), bio                                                                                                      |
| PUT/DELETE | `/me/avatar`          | upload → async processing; DELETE doesn't reset cooldown                                                                            |

## Polls & proposals (M2) — implemented

| Method     | Path                                               | Who              | Notes / errors                                                                                                    |
| ---------- | -------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| POST       | `/proposals`                                       | member           | `Idempotency-Key` header; `{text, visibility}`; debits 1 PP; `PP_INSUFFICIENT`, auto `duplicate_exact` (refunded) |
| GET        | `/me/polls`                                        | member           | approved only, with respondent counts                                                                             |
| GET        | `/me/pp`                                           | member           | balance + last 50 ledger entries                                                                                  |
| PUT        | `/me/settings/poll-attribution`                    | member           | `{hideNameOnAllPolls}`                                                                                            |
| GET/POST   | `/me/notifications`, `/me/notifications/{id}/read` | member           |                                                                                                                   |
| GET        | `/daily/poll`                                      | member           | today's Daily Poll or `available:false`                                                                           |
| GET        | `/staff/proposals?route=`                          | moderator+       | pending queue (normal/sensitive/similarity), shows creator                                                        |
| POST       | `/staff/proposals/{id}/decision`                   | moderator+       | approve (staff fix wording if needed) / reject(reason); never sent back to the submitter                          |
| POST       | `/staff/proposals/{id}/route`                      | moderator+       | move between queues                                                                                               |
| POST       | `/staff/proposals/{id}/refund-correction`          | super_moderator+ | grant / reverse                                                                                                   |
| PATCH      | `/staff/polls/{id}`                                | moderator+       | wording, queued polls only                                                                                        |
| POST       | `/staff/polls`                                     | admin+           | seed a poll without PP                                                                                            |
| GET        | `/staff/daily`                                     | admin+           | queue, schedule, recent features, exceptions                                                                      |
| PUT/DELETE | `/staff/daily/calendar/{date}`                     | admin+           | future dates only                                                                                                 |
| POST       | `/staff/daily/emergency-replace`                   | admin+           | `{reason, replacementPollId?}`                                                                                    |

## Surveys & PP (M3) — implemented

| Method  | Path                                 | Notes / errors                                                                                                                                                                                                   |
| ------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET     | `/daily`                             | Daily Poll (or unavailable), 10 assigned surveys, progress `{completed, target: 11, possible}`, `ppAwarded`, announcement + reminder flags                                                                       |
| POST    | `/daily/poll/response`               | `{pollId, text}` → `{status:"accepted", message:"Thank you for your response", alreadyAnswered, countsForProgress, progress, ppAwarded}`; `RESPONSE_REJECTED` (422), `DAY_ROLLED_OVER`, `DAILY_POLL_UNAVAILABLE` |
| POST    | `/daily/assignments/{slot}/response` | same body/result; `ALREADY_ANSWERED`, `POLL_UNAVAILABLE`, `DAY_ROLLED_OVER`; 60/min per person                                                                                                                   |
| POST    | `/daily/announcement/seen`           | hides today's announcement                                                                                                                                                                                       |
| GET     | `/me/streaks`                        | answering + guessing current/longest (own)                                                                                                                                                                       |
| GET/PUT | `/me/settings/notifications`         | `{dailyPollAnnouncement, answeringReminder, guessingReminder}`                                                                                                                                                   |

## Guessing (M4) — implemented

| Method | Path                                    | Notes / errors                                                                                                                                    |
| ------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/games/status`                         | games used/left today, active game id                                                                                                             |
| POST   | `/games/solo`                           | server picks the poll; `ACTIVE_GAME_EXISTS`, `DAILY_LIMIT_REACHED`, `NO_ELIGIBLE_POLL`                                                            |
| GET    | `/games/{id}`                           | question, found answers + %, score, strikes, remaining, outcome, own guesses; never the full list                                                 |
| POST   | `/games/{id}/guesses`                   | `{text, clientRequestId}` → `correct` (answer, percent) / `incorrect` / `already_guessed` + game; `GAME_OVER`, `INVALID_GUESS`                    |
| POST   | `/games/{id}/leave`                     | `{confirm:true}`; only before the first guess → released (no charge); after that `GAME_IN_PROGRESS` (resume via `/games/status` → `activeGameId`) |
| GET    | `/me/stats`                             | solo record, accuracy, Rarest Correct Guess, record-holder badge                                                                                  |
| GET    | `/records/rarest-guess`                 | sitewide record percent + holders (usernames)                                                                                                     |
| GET    | `/staff/polls/{id}/answer-keys`         | moderator+: normalized keys + counts + groups (no raw text)                                                                                       |
| POST   | `/staff/polls/{id}/answer-groups/merge` | moderator+: `{keys, into}`                                                                                                                        |

## Multiplayer WebSocket (M5)

Client → server: `queue.join{mode}`, `queue.cancel`, `room.create`, `room.invite`, `match.guess`, `match.pause.request`, `vote.cast{roundId, value}`, `ready`, `nevermind`, `leave.confirm`, `chat.pause.send`.
Server → client (player channel): `match.state{stateVersion,…}`, `guess.result` (own words only), `opponent.guess{playerId, n, result, percent}` (no words), `vote.opened/closed`, `timer{kind, endsAt}`, `match.ended{outcome}`.
Server → spectator channel: same as opponent view; never words, never duplicates, never answer list.
Every event carries `stateVersion`; clients resync via `match.snapshot` on reconnect.

## Social & moderation (M6) — to be detailed at M6 start

Profiles, relationships, blocks, DMs, groups, reports (`POST /reports` → always `{message:"Report submitted"}`), staff cases, appeals, leaderboards (`GET /leaderboards/{solo|multi}/{week|month|all}`).
