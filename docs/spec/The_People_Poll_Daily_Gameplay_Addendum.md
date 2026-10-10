# The People Poll — Daily Guessing Allowance Addendum

**Status:** User-approved product decisions and supporting implementation safeguards, October 10, 2026.  
**Relationship to master specification:** Supplements Version 1.0. All other existing decisions remain unchanged. This addendum does not overwrite the original specification.

## Approved rules

1. A user may make **10 total guessing-game participations per day**, shared across solo games and all multiplayer modes in any combination. The 11 daily survey-answer opportunities and the maximum one Poll Point per day are separate and unchanged.
2. The day boundary is **12:00 AM America/New_York**, including daylight-saving changes.
3. A game consumes one of the 10 allowances **only when the user's first accepted gameplay guess is recorded**. Merely opening a poll, entering a lobby, spectating, or joining a game does not charge an allowance.
4. When a match starts, reserve an available allowance for each participant. If a player exits or the match ends without that player ever submitting an accepted guess, release their reservation without charging. If they have guessed, the charge remains, including on early termination, forfeit, or disconnection.
5. A player may participate in **only one active guessing game at a time**, whether solo or multiplayer. Other website activities and spectating remain available. Spectating is unlimited and does not reserve or charge allowances.
6. Existing multiplayer reconnect, pause, Ready, vote-to-continue, and outage rules remain in force. A temporary disconnection does not release a reservation while an authorized rejoin remains possible. A player who reconnects before their first guess may resume without being charged merely for reconnecting.
7. A game already underway is allowed to finish when the user reaches their daily limit or midnight passes. A first accepted guess after midnight is charged to the **new calendar day**; a first accepted guess before midnight is charged to the **previous day**, even if the game ends after midnight. Do not charge the same game twice.
8. If a user has reached 10 charged games for the current day, they may not begin a further guessing game requiring a new allowance that day. Existing replay restrictions and automatic poll eligibility remain unchanged.

## Engineering safeguards (implementation, not new product choices)

- Enforce one active guessing participation per account across all devices, tabs, and modes, with atomic server-side state transitions.
- Maintain a shared daily allowance ledger with distinct `reserved` and `charged` states, unique per participation, and idempotent first-guess processing. Prevent concurrent joins/guesses from oversubscribing remaining capacity.
- Keep reservations bound to match/participation IDs, not permanently to the date of entry. On a first guess after midnight, validate and charge the new day's allowance atomically; release the prior-day reservation without a charge.
- Protect active reservations during legitimate reconnection windows. Release them exactly once on final termination before any accepted guess.
- Avoid duplicate charging after retries, repeated messages, reconnects, and server recovery. Preserve an auditable event trail.
- Do not reveal an ineligible or played poll merely because a user has an unused allowance; eligibility and the 30-day-plus-substantial-change replay rule remain separate requirements.

## Implementation edge case to resolve without changing the product rules

**Cross-midnight admission:** A participant may reserve their last allowance before midnight but not guess until after midnight. The new-day allowance must be checked at first guess. Under the one-active-game restriction, the user ordinarily has no competing active game, but server retries and race conditions still require atomic handling. If the new-day allowance cannot be charged, do not silently accept an uncharged guess; safely block and recover the participation, following established match fairness and outage rules where applicable. The precise recovery UI and any multi-device race handling are engineering details.

**Daily-limit empty state:** When 10 charges are used, show a clear reset message; when no eligible unplayed polls exist, show the separate existing no-eligible-polls message. Do not imply a daily reset makes played polls automatically replayable.
