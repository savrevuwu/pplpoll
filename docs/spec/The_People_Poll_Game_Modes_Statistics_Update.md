# THE PEOPLE POLL — GAME MODES & STATISTICS UPDATE

> Received from the product owner on 2026-10-12. Addition to the Master Specification v2; all previously confirmed requirements stand unless explicitly updated here.

This is an addition to the existing master specification for The People Poll. Preserve all previously confirmed requirements unless explicitly updated below. Do not import rules from other projects.

Before implementing: Review the existing code and specification. Identify conflicts, dependencies, and anything already implemented. Do not silently replace working features. Apply the following decisions consistently across gameplay, matchmaking, profiles, statistics, leaderboards, and tests.

## 1. Multiplayer Modes

Support three competitive modes:

- Head-to-Head: Exactly 2 players (1v1).
- Teams: Exactly 4 players (2v2).
- Free-for-All: 3–6 individual players.

Each supports two formats:

- Classic: Two-minute match with alternating turns.
- Speed Round: One-minute match with simultaneous guessing.

These are match-duration limits, not per-turn timers. All matches use server-authoritative timers and frozen poll-result snapshots.

## 2. Guessing and Scoring

Preserve the established 60% target, three-strike limit, and poll-dependent 10–20 total-guess limit.

In individual competitions, each player maintains their own guesses, strikes, and score. Different opponents may correctly guess the same answer and independently earn its percentage.

In Teams, each team shares one pool of guesses, strikes, and score. Each answer may count only once per team. If a teammate repeats an answer already guessed by their team, display Already Guessed without awarding points or consuming an attempt or strike.

Opposing teams can independently earn credit for the same answer.

Record which teammate contributed each unique correct answer. Display individual contributions alongside the combined team percentage.

In Classic Teams, teams alternate turns and teammates rotate who submits their team's next guess. In Speed Teams, both teams guess simultaneously, while each team still shares one answer pool.

Keep opponents' actual guessed words hidden during matches.

## 3. Winners and Tiebreakers

Use the following ranking order consistently in Head-to-Head, Teams, and Free-for-All:

1. Highest final percentage.
2. If tied, earliest time reaching that final percentage.
3. If still tied, fewest correct guesses used to reach that percentage.
4. If all measurements remain identical, declare a draw/tie.

Use authoritative timestamps and precise stored percentages, not rounded display values.

For Teams, apply comparisons to the team's combined unique-answer percentage and correct-guess count.

In Free-for-All, award and record first, second, and third place using these ranking rules. Preserve genuine ties rather than inventing arbitrary winners.

## 4. Match Formats

Support Best-of-3 and Best-of-5 for Head-to-Head and Teams.

These options must be available through:

- Public matchmaking
- Private rooms
- Friend challenges

Each round uses a different poll eligible for every participant. The competitor or team winning the most rounds wins the overall match. Preserve existing disconnect, pause, forfeiture, and invalidation protections.

## 5. Tournament Mode

Support single-elimination tournaments for:

- Individual 1v1: 4, 8, or 16 players.
- Team 2v2: 4, 8, or 16 teams.

Support Classic and Speed Round. Each matchup uses a different eligible poll, with winners advancing through the bracket.

Track tournament participation, championships, and placements separately for individual and team tournaments.

Use the established competitive tiebreakers. Do not arbitrarily advance someone if a matchup remains a true draw; identify and resolve that bracket-progression case before implementation.

## 6. Mystery Challenge

Add a separate solo Mystery Challenge mode.

- Randomly assign eligible, previously unplayed polls.
- Allow players to start new challenges whenever eligible polls are available.
- Give each challenge a special, achievable objective.
- Validate objectives against the poll's frozen answer distribution.
- Preserve normal guessing limits and three-strike rules.
- Track attempts, completions, failures, and personal records.
- Do not charge Poll Points.
- Keep this separate from the Daily Poll and daily survey requirements.

## 7. Player Statistics

Track overall and per-mode statistics, including:

- Games played
- Wins, losses, and draws
- First-, second-, and third-place finishes
- Correct guesses and guessing performance
- Individual contribution in team matches
- Classic versus Speed Round performance
- Head-to-Head, Teams, and Free-for-All performance
- Tournament entries, championships, and placements
- Mystery Challenge results
- Current and longest competitive win streaks
- Consecutive days with at least one competitive win
- Solo success streaks

Do not incorrectly count invalidated games, no-contest matches, or protected technical interruptions as competitive wins or losses.

## 8. Rarest Correct Guess Statistic

Every player profile must display Rarest Correct Guess alongside other gameplay statistics.

This is the lowest-percentage valid correct answer the player has ever personally guessed.

- Show its exact recorded percentage, with appropriate display precision.
- Update the record when the player earns a rarer valid correct guess.
- Use the frozen poll-result percentage from the time of the game.
- Preserve historical achievements when ordinary survey percentages change.
- Count valid completed games across Solo and multiplayer modes.
- In Teams, credit the actual teammate who submitted the answer.
- Exclude cheating, invalidated matches, and illegitimate results.

## 9. Rarest Guess Record Holder Badge

Award an exclusive Rarest Guess Record Holder profile badge to the player or players holding the lowest legitimate correct-guess percentage sitewide.

- Tied record holders share the badge.
- A strictly lower valid percentage establishes a new record.
- Previous holders lose the exclusive badge when surpassed, but retain their personal statistics.
- Compare stored percentages at full precision.
- Recalculate badge ownership if a record is invalidated.
- Do not reveal hidden survey answers or private gameplay information through the badge.

## 10. Preserve Existing Systems

These changes must not alter:

- Daily Poll scheduling and the new-question queue
- The 11 daily survey-response requirements
- Poll Points and poll submissions
- Permanent survey responses
- Poll eligibility and result snapshots
- Existing privacy and anonymity settings
- Spectator restrictions
- Blocking and social features
- Staff permissions and moderation
- Anti-cheat protections
- Existing pause, reconnect, and Vote to Continue rules

In particular, Daily Polls collect survey answers; they are not guessing games. Every newly approved poll enters the Daily Poll queue with zero survey responses. It becomes available for regular surveys after its Daily Poll debut, and for guessing gameplay only after meeting the existing eligibility requirements.

## 11. Implementation Instructions

Before coding, produce a concise impact assessment identifying:

1. Existing features affected by these changes.
2. Database/schema updates required.
3. Matchmaking, timing, and scoring changes.
4. Any genuine contradictions or unresolved technical edge cases.
5. Tests needed for individual, team, tournament, and challenge gameplay.
6. A safe, dependency-ordered implementation plan.

Do not invent major product rules where a decision is missing. Ask only questions that genuinely require the product owner's decision.

Implement in controlled batches with tests and report what is completed versus still pending.

End of update.
