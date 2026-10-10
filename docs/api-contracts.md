# API & Real-time Contracts (PROPOSAL — outline)

Conventions: JSON over HTTPS; session cookie + `X-CSRF-Token` on mutations; `Idempotency-Key` header required on every mutation that changes PP, responses, allowances, or match state. Errors: `{ "error": { "code": "STRING_CODE", "message": "safe text" } }` — never include answers, distributions, other users' data, or moderation details. All inputs validated with Zod; unknown fields rejected (mass-assignment protection). Rate limits per account + per IP (IP never used as identity proof).

## Auth & account (M1)
| Method | Path | Notes / errors |
|---|---|---|
| POST | `/auth/invite/check` | `{code}` → `{valid}`; brute-force limited; does not consume |
| POST | `/auth/register` | `{code, email, password, username}`; atomic consume on success; `INVITE_INVALID`, `USERNAME_TAKEN` (incl. reserved), `EMAIL_IN_USE` |
| POST | `/auth/verify-email` | token |
| POST | `/auth/login` | interactive sign-in; **reactivates deactivated account** |
| POST | `/auth/refresh` | background refresh; **never reactivates** |
| POST | `/auth/logout` | |
| POST | `/account/deactivate` | starts new one-year period |
| PATCH | `/me/profile` | display name (168 h rule), bio |
| PUT/DELETE | `/me/avatar` | upload → async processing; DELETE doesn't reset cooldown |

## Polls & proposals (M2)
| POST | `/proposals` | debits 1 PP atomically; `PP_INSUFFICIENT`, `DUPLICATE_EXACT` (auto-reject, refunded) |
| GET | `/me/polls` | approved only, with respondent counts |
| GET/PUT | `/staff/daily-calendar/{date}` | Admin/Owner |
| POST | `/staff/daily/{date}/emergency-replace` | Admin/Owner; replacement must be queued 0-response |
| POST | `/staff/proposals/{id}/decision` | approve / reject(refund flag) / edit / request-revision |

## Surveys & PP (M3)
| GET | `/daily` | today's assignments, progress n/11, PP awarded?, Daily Poll or `DAILY_POLL_UNAVAILABLE` |
| POST | `/daily/assignments/{slot}/response` | `{text}` → `{status:"accepted", message:"Thank you for your response"}`; `ALREADY_ANSWERED`, `DAY_ROLLED_OVER`, `RESPONSE_REJECTED_QUALITY` |
| GET | `/me/pp` | balance + ledger (own) |

## Guessing (M4)
| POST | `/games/solo` | starts; `DAILY_LIMIT_REACHED`, `NO_ELIGIBLE_POLL`, `ACTIVE_GAME_EXISTS`, `GUESSING_SUSPENDED` |
| POST | `/games/{id}/guesses` | `{text, clientRequestId}` → `{result: correct|incorrect|already_guessed, percent?, cumulative, strikes, remaining, outcome?}` |
| POST | `/games/{id}/leave` | confirmation required |

## Multiplayer WebSocket (M5)
Client → server: `queue.join{mode}`, `queue.cancel`, `room.create`, `room.invite`, `match.guess`, `match.pause.request`, `vote.cast{roundId, value}`, `ready`, `nevermind`, `leave.confirm`, `chat.pause.send`.
Server → client (player channel): `match.state{stateVersion,…}`, `guess.result` (own words only), `opponent.guess{playerId, n, result, percent}` (no words), `vote.opened/closed`, `timer{kind, endsAt}`, `match.ended{outcome}`.
Server → spectator channel: same as opponent view; never words, never duplicates, never answer list.
Every event carries `stateVersion`; clients resync via `match.snapshot` on reconnect.

## Social & moderation (M6) — to be detailed at M6 start
Profiles, relationships, blocks, DMs, groups, reports (`POST /reports` → always `{message:"Report submitted"}`), staff cases, appeals, leaderboards (`GET /leaderboards/{solo|multi}/{week|month|all}`).
