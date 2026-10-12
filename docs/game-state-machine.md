# Server-Authoritative State Machines (PROPOSAL)

General rules for every machine:

- State lives in Postgres. Each transition runs in one transaction guarded by `state_version` (optimistic lock: `UPDATE … WHERE id=$1 AND state_version=$2`).
- Every client command carries a `client_request_id`; duplicates return the original result (idempotent).
- Time comes from the DB server clock (`now()`); timers are pg-boss jobs keyed by `(entity, state_version, timer_kind)` and are no-ops if the version moved on.
- Terminal states are absorbing: any event on a terminal entity returns the stored outcome.

## 1. Poll / Daily Poll lifecycle

```
proposal: pending ──approve──> [poll] queued (0 responses)
            │ └──reject (refund? per reason)──> rejected
            └──request revision──> revision_requested ──staff edit/approve──> queued

poll: queued ──00:00 ET publish (scheduled or auto)──> live_daily ──next 00:00 ET──> survey
      live_daily ──emergency removal──> removed   (replacement = another queued poll → live_daily)
      survey ──moderation removal──> removed
```

Guards: only `queued` polls with `response_count = 0` may be published; `daily_features.poll_id` unique ⇒ a poll is featured at most once; empty queue ⇒ `daily_poll_exceptions` + alert, no fallback. Survey responses accepted only in `live_daily`/`survey`. Game eligibility is a property of the latest snapshot (respondents ≥ 100 and K ≤ 17), not a poll state.

## 2. Daily survey progress (per user, per ET date)

```
day_open ──user first visits──> assigned (slot 0 = Daily Poll, slots 1..10 = regular)
assigned ──answer slot──> in_progress(n) ──11th counted answer──> complete ──(same tx)──> pp_awarded
```

- Regular slots: polls in `survey` status the user's participation identity has never answered; picked server-side; if fewer than 10 exist, fewer slots are assigned and the day cannot complete (no invented credit).
- Emergency replacement: if the user's slot 0 response was on the removed original, slot 0 stays complete; a replacement answer is stored with `counts_for_progress = false`. Otherwise slot 0 is re-pointed to the replacement.
- PP award: `INSERT pp_ledger … ON CONFLICT (user_id, et_date) WHERE kind='daily_award' DO NOTHING` + balance increment in same tx. Answering streak advances in the same tx.
- Midnight: an answer is attributed to the ET date of the assignment it fulfils, and only if submitted before that date ends; after 00:00 ET a stale assignment is rejected with "new day — refreshed".

## 3. Guessing participation & allowance (solo and multiplayer)

```
none ──start/join match (allowance check: charged(today)+reserved < 10, no other active)──> reserved
reserved ──first accepted guess (charge ET date of guess; mark played)──> charged/active
reserved ──end without accepted guess──> released (no charge)
charged ──game ends (any reason)──> ended (charge kept)
reserved ──first guess after midnight, new day full──> released + participation ended (guess not stored)
```

- Single active participation: partial unique index on `game_participations(user_id) WHERE status IN ('reserved','active')`.
- Charge: `UPDATE daily_charges SET charged = charged+1 WHERE user_id=$1 AND et_date=$2 AND charged < 10` (upsert) + `allowance_events(kind='charge')` unique per participation + `played_polls` insert — one transaction.
- Duplicate/equivalent guess → result `duplicate` ("Already guessed"), no slot, no strike, no charge, not shown to spectators.
- Reconnect within protection keeps the same participation and reservation.

## 4. Solo game

```
starting ──server selects eligible poll, freezes snapshot──> active
active ──correct guess, cumulative ≥ 60%──> won
active ──3rd incorrect guess──> lost
active ──accepted guesses = cap without 60%──> lost
active ──user leaves / timeout──> abandoned (lost if any accepted guess; released if none)
```

Eligible poll for user U: latest snapshot eligible (respondents ≥ 100, K ≤ 17), poll not removed, and (not in `played_polls` for U, OR replay-eligible per §23.2). Result reveal: only the user's correct groups + percentages, cumulative %, remaining attempts, outcome — never the full list.

## 5. Multiplayer match

> The ACTIVE sub-machine (turns, win condition, timeouts) depends on **open question Q1** and is deliberately left unspecified.

```
LOBBY ──start guard──> STARTING ──poll chosen + snapshot frozen + reservations ok──> ACTIVE
  start guard: versus ⇒ exactly 2; other modes ⇒ 3..6 active players; all mutually non-blocked;
               ≥1 poll eligible for every participant; each participant has an allowance.
  (no eligible poll ⇒ stay in LOBBY with message; never start below minimum)

ACTIVE ──[private/friends] pause request──> PAUSE_VOTE
PAUSE_VOTE ──yes ≥ ceil(0.51 × other_connected) & pauses_used < 2──> PAUSED (pauses_used+1, Pause Chat on)
PAUSE_VOTE ──fail / cancel──> ACTIVE (no allowance used)
PAUSED ──all eligible Ready──> ACTIVE
PAUSED ──10 min elapsed──> FINAL_READY_60S ──all Ready──> ACTIVE
                                   └──timeout: non-ready players forfeit──> FORFEIT_RESOLUTION
PAUSED ──kick vote 100% of other eligible (target excluded)──> FORFEIT_RESOLUTION

ACTIVE ──player disconnects──> DISCONNECT_VOTE_60S   (if reconnect vote permitted: Q3; else GRACE_60S)
DISCONNECT_VOTE_60S ──yes ≥ ceil(0.51 × remaining_connected)──> RECONNECT_PROTECTED_60S (counts as pause where applicable)
DISCONNECT_VOTE_60S ──fail──> remaining fallback grace (clock started at disconnect; not stacked, see note)
RECONNECT_PROTECTED_60S ──reconnect──> READY_CHECK
RECONNECT_PROTECTED_60S ──60s elapsed──> RECONNECT_WAIT (Nevermind enabled: unanimous remaining connected)
RECONNECT_WAIT ──reconnect──> READY_CHECK ; ──Nevermind unanimous──> FORFEIT_RESOLUTION
GRACE_60S ──reconnect──> ACTIVE ; ──expired──> FORFEIT_RESOLUTION

ACTIVE ──confirmed voluntary leave / removal──> FORFEIT_RESOLUTION

FORFEIT_RESOLUTION:
  remaining < mode minimum (3+ modes: < 3; versus: < 2) ──> ENDED_NO_WINNER
  else ──> CONTINUE_VOTE_60S (Pause Chat on)
CONTINUE_VOTE_60S ──all remaining eligible vote Yes──> READY_CHECK
CONTINUE_VOTE_60S ──any No / missing──> ENDED_NO_WINNER
READY_CHECK ──all Ready──> ACTIVE

any non-terminal ──system outage detected──> TECH_PAUSE (timers frozen, no vote, no pause quota)
TECH_PAUSE ──recovered──> TECH_READY_60S ──all Ready──> ACTIVE
TECH_PAUSE/TECH_READY_60S ──not all Ready or unrecoverable──> ENDED_DRAW

ACTIVE ──win/loss condition (Q1)──> COMPLETED
terminal: COMPLETED | ENDED_NO_WINNER | ENDED_DRAW | INVALIDATED (cheating)
```

Notes:

- **Quorum math** uses explicit integer arithmetic: `required = ceil(0.51 × n)` where `n` = eligible voters excluding the requester/target; if `n = 0`, the vote cannot pass (and the situation is resolved by FORFEIT_RESOLUTION minimum-player rules).
- **No stacking:** a disconnected player gets _either_ the approved protected wait _or_ the 60-second automatic grace, measured from the disconnect timestamp, never both back-to-back. While a disconnect vote is open, the grace clock runs concurrently; approval converts the remaining window into protected wait.
- Timers freeze in PAUSED/TECH_PAUSE (remaining durations stored, resumed from stored values).
- ENDED_NO_WINNER / ENDED_DRAW: no win/loss/leaderboard effect; charges for players with an accepted guess remain; reservations without accepted guess release.
- Spectator feed emits only: question, participant usernames (privacy-filtered), numbered accepted-guess events (result + percentage, never words), running totals, strikes, outcomes. Duplicates are never emitted.
