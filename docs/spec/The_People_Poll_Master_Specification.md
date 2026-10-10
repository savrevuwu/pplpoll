# THE PEOPLE POLL
## Master Product & Engineering Specification
**Version:** 1.0 — Consolidated design handoff | **Date:** October 10, 2026

> **Project boundary:** This document covers THE PEOPLE POLL only. Do not import assumptions, features, eligibility rules, moderation policies, or technical decisions from any other website or prior project. The rules below are product requirements, not evidence that features have already been implemented or tested.

## 1. Product concept and essential separation
The People Poll combines two distinct experiences: **(A) collecting original, permanent survey responses** and **(B) guessing the most popular responses other people gave**. Answering a survey is NOT playing a guessing game. Do not reuse the guessing UI, guess limits, percentages, or strikes in the survey-submission flow.

- **Daily Poll:** one newly introduced question each calendar day; its first survey responses are collected that day. Example: “Name something you keep in your purse.” User answers “Keys” and sees “Thank you for your response.” There is no guessing.
- **10 additional daily surveys:** existing questions, ordinarily from prior Daily Polls, to which the player has not previously submitted a survey response. Each accepts one genuine permanent answer.
- **Solo and multiplayer guessing:** separate game modes using results already gathered from survey participants. Players guess popular answers and try to reach 60% of respondents.
- A person may submit only one accepted survey response per poll for life; this remains true across account deletion and recreation, subject to privacy-preserving, legally reviewed identity/deduplication implementation.
- Survey answers and guessing attempts have independent state. Viewing a poll or answering its survey does not mark it played.

## 2. Definitive poll lifecycle
1. User earns Poll Points and submits a proposed question for review.
2. Staff reviews the proposal. If approved, it enters the **Daily Poll queue with ZERO survey responses**. No user can answer it before its Daily Poll debut. **Every new approved question must pass through this queue; there are no exceptions.**
3. Owner/Admin may schedule approved queued questions on a staff-only Daily Poll calendar, edit upcoming choices, or leave a day unscheduled. If unscheduled, the system automatically selects an eligible queued question.
4. At **12:00 AM America/New_York** on its featured day, the question debuts as the new Daily Poll and becomes answerable for the first time. It is a survey, not a guessing game. In-app daily announcement respects user notification settings.
5. Once the Daily Poll day ends, the question becomes an existing survey question eligible for the 10 regular daily survey opportunities, excluding people who already answered it. Responses can continue to accumulate.
6. Once it has **at least 100 valid unique human respondents** and a playable answer distribution, it may enter solo/multiplayer guessing pools. The 100-response minimum is **not** required for the Daily Poll or regular survey collection.
7. The poll persists indefinitely unless removed for legitimate moderation reasons. It never becomes a new Daily Poll again. No public poll directory/search or user-selected game poll.

**Operational edge cases:** Staff may replace a removed featured Daily Poll immediately, but the replacement must come from the untouched zero-response Daily Poll queue. Preserve auditable records of replacement and the responses already collected for any removed question; do not silently treat a previously answered question as “new.” If the queue is empty, do not recycle an old question or fabricate a new one: show a controlled unavailable state, alert staff, and record the exception. Exact PP treatment for an emergency replacement with users already having completed that day's original Daily Poll should be implemented fairly and tested, not silently double-counted.

## 3. Daily participation, Poll Points, and reset
- Global day boundary: **12:00 AM America/New_York**, correctly handling EST/EDT and daylight-saving transitions.
- Daily target: **1 Daily Poll survey response + 10 additional existing-poll survey responses = 11 accepted responses**.
- Completing all 11 grants **1 Poll Point (PP), maximum 1 PP per day**. No partial credit or rollover. PP is used to submit poll proposals (1 PP per submission).
- Only daily survey responses in their designated opportunities count toward daily PP progress. Multiplayer survey interactions, if any, do not count.
- The 10 regular survey assignments must exclude polls the user has answered previously; use available eligible questions and handle pool exhaustion gracefully without inventing credit.
- Daily Poll is genuinely new, so it has no prior survey answers. Do not implement the previously discussed “already answered the new Daily Poll” exception; it arose from an incorrect earlier interpretation.
- Daily progress, PP awards, and spending must be atomic and idempotent to prevent double awards, overspending, or midnight races. Maintain auditable PP ledger.

## 4. Survey collection and answer quality
- Accept one free-text response per person per poll. Present a simple submission/confirmation flow and clear “Thank you for your response” success state.
- Require genuine, unique human participation. Reject garbage, spam, nonanswers, abuse, automated responses, and attempts to stuff polls; do not invent or seed synthetic votes.
- Group semantically equivalent answers for gameplay (e.g., reasonable spelling, plural/singular, synonyms) while preserving raw response records in restricted storage for quality review. Grouping should not collapse meaningfully different answers.
- Enforce server-side duplicate response prevention, including simultaneous submissions and account recreation. Shared IP/device alone is not proof of identity or abuse.
- New accepted responses accumulate continually. Publish updated gameplay result snapshots **every 24 hours**; each started game uses one frozen, versioned snapshot for its entire duration. Maintain reproducible answer normalization and percentages.
- Staff may remove actually prohibited responses; legitimate responses remain in aggregate regardless of respondent's freeze, ban, or deletion. If moderation changes counts, recalculate at the next applicable snapshot and maintain auditability.

## 5. Guessing gameplay — common rules
- A poll is game-eligible only after **100 valid unique survey respondents** and a distribution allowing realistic attainment of **60%** within the guessing limits. Exclude unplayable distributions until they improve.
- Goal: discover answers accounting for at least **60%** of survey respondents, using displayed percentages based on real results.
- Maximum **3 incorrect guesses**. Total accepted gameplay guesses limited to **10–20**, determined by the poll's actual distribution under a documented deterministic server rule. Do not arbitrarily give all polls the same cap.
- Duplicate or equivalent guesses display **“Already guessed”** and consume no guess slot or strike. Do not expose these as numbered guesses to spectators.
- A poll becomes **played** for that user only upon their first accepted gameplay guess; opening/viewing it or answering the survey is not gameplay.
- Automatically skip previously played polls in every guessing mode. A played poll may become replay-eligible only after **30+ days AND substantial changes in genuine results**, using a documented measurable threshold; replay never grants another survey response.
- Show successful guessed answers and their percentages, cumulative uncovered percentage, remaining attempts, and outcome. Do **not** reveal the entire answer list after a game, including on loss.
- Opponents must not see one another's actual guessed words during active gameplay.
- Poll selection is automatic and server-authoritative; no public browsing, search, directories, or manual poll choice in any mode.

## 6. Solo gameplay
- Separate from the Daily Poll and the 10 daily survey-answer tasks. Playing solo does not count toward 11 daily survey responses or generate PP.
- Select a game-eligible, unplayed poll automatically; use frozen result snapshot and the common 60% / strike / total-guess rules.
- Persist played status after first accepted guess, even if the game ends early, disconnects, or the user leaves.
- When no eligible unplayed poll exists, provide an informative empty state; never silently recycle an ineligible poll.

## 7. Multiplayer: modes, matching, and fairness
- Public matchmaking, private rooms, and friend challenges. Public matching is **first available compatible players**, not skill-based. Queue remains active until a match or user cancellation.
- No formal ranked mode at initial launch. Public leaderboards for competitive statistics can exist without ranked ratings; ranked mode is a later, separately approved feature.
- Match host cannot choose the poll. Server must choose a poll eligible for **every participant**; do not begin if none is eligible. Freeze one identical result snapshot for all.
- Keep match state, timers, strikes, eligibility, accepted guesses, forfeits, and outcomes authoritative on the server. Reconnect must not duplicate actions or reveal secret answers.
- Private game spectator permissions controlled by host; other spectator access must respect mode/privacy. Spectators see question, participant usernames (subject to privacy), numbered guess events, percentages, running totals, strikes, and outcomes, but **never the guessed words or the full answer list**. Spectating neither marks a poll played nor contributes to PP.
- Blocking during a game does not automatically end it or force forfeit. Participants may finish without direct interaction; do not match them together again. Serious threats can trigger protective moderation.

## 8. Pauses, disconnects, vote-to-continue, and outages
### 8.1 Private/friends requested pauses
- Up to **2 successful approved manual pauses per match**, each at most **10 minutes**. Failed/canceled votes do not use an allowance. Public matchmaking does not offer voluntary player-controlled pauses.
- Any player may request; approval requires **at least 51% of OTHER connected players** (exclude requester). Calculate threshold explicitly and avoid zero-denominator ambiguities.
- Freeze game state/timers, hide active gameplay, and automatically open **Pause Chat** (text and emoji only; no GIFs/images/files). Sharing hidden answers is a violation.
- After pause, **every remaining eligible player must press Ready**; never resume automatically.
- When a 10-minute pause expires, begin a final **60-second Ready countdown**. Players who fail to ready forfeit, followed by the universal vote-to-continue flow where applicable.
- Vote-kicking an inactive player while paused requires **100% approval from all other eligible players**; target does not vote.
### 8.2 Disconnect pause
- Remaining players receive a **60-second vote**; >=51% of remaining connected players must approve a reconnect pause.
- Once approved, the disconnected player gets a protected **60-second reconnect wait** during which “Nevermind” is disabled. After that, **all remaining connected players** must approve Nevermind to stop waiting early. Keep Ready and Nevermind distinct.
- A successful approved pause counts toward the two-pause cap when applicable; document precise interaction with mode limits in implementation tests. Ordinary disconnects are not system outages.
### 8.3 Universal Vote to Continue
- Whenever a player voluntarily leaves (confirmed forfeit), disconnects and forfeits, or is removed in any multiplayer mode, freeze match and open Pause Chat.
- If enough participants remain, all remaining eligible players must vote **Yes unanimously within 60 seconds** to continue. Any No, missing vote, or insufficient participants ends the match **with no winner or loser and no competitive win/loss/rating impact**. Never award a win simply because an opponent forfeited.
- After unanimous Yes, every remaining participant must press Ready before gameplay resumes. Previously played polls remain played; unplayed polls remain eligible.
- Voluntary leaving requires confirmation, forfeits the player's participation, prevents competitor rejoin, and does not itself consume a pause.
### 8.4 Genuine technical/system outage
- System-controlled automatic pause for genuine service failures in any multiplayer mode; no votes required and does **not** consume either private manual pause.
- Freeze timers and progress. After recovery, conduct **60-second Ready check** for all remaining eligible players. If not all Ready, or match unrecoverable, end in **draw** without competitive win/loss/rating impact. Do not conflate outage recovery with voluntary Vote to Continue.

## 9. Poll proposals, moderation, and creator features
- Submitting a proposal costs **1 PP**; multiple pending submissions allowed if PP available, subject to abuse protections. No user editing or withdrawal after submission. Staff may correct wording during review.
- Review routes: clearly acceptable normal queue; sensitive/gray-area separate queue; similar-but-not-exact duplicate similarity queue; exact duplicates automatically rejected after trivial punctuation/case/spacing normalization.
- Staff may approve, reject, edit wording, or request revision. Audit edits and decisions. Never change a live question's meaning so previously collected responses become misleading. Time-specific/year-specific questions stay historically accurate; a new year is a new question.
- **Refund 1 PP** for good-faith rejection (e.g., exact/similar duplicate, quality, unsuitable gameplay). **No refund** for prohibited, malicious, abusive, or spam submissions. Record reason; authorized staff can correct mistaken refund. Escalate repeated confirmed malicious submissions proportionately, not one reasonable borderline proposal.
- Creator may answer and play their own poll under identical rules; no access to secret answers or advantageous controls.
- Creator receives **approval/go-live notification only**, linking to answer their newly featured survey; no respondent-count milestone notifications.
- **My Polls shows approved questions only** and each one's valid respondent count. Pending/rejected questions never appear there.
- Each proposal has original creator visibility choice (public/anonymous). A global **“Hide my name on all polls”** switch overrides all public attribution while enabled; switching it off restores original per-poll choices. Staff can identify creator. Anonymous polls still appear in creator's My Polls. Polls persist without creator attribution when creator is frozen, banned, or deleted.

## 10. Accounts, identity, and registration
- Invite-only beta, **not restricted by gender**. Owner distributes codes, including through Discord DMs. Enter code before email registration and email verification.
- Owner creates single-use or configurable-use-limit reusable invite codes, optionally expiring; can copy, revoke, and monitor redemptions. Brute-force protection; consume code atomically only after successful registration.
- One account per person. Investigate suspected duplicates with corroborating evidence; shared IP or device alone is insufficient. Ban evasion is actionable when verified.
- Username: **3–20 characters**, ASCII letters A–Z/a–z and digits 0–9 only; unique case-insensitively, immutable for ordinary users. Every username ever assigned stays permanently reserved, including deleted/banned/staff-forced changes.
- Display name: **1–20 characters**, letters/numbers/spaces only; nonunique, trimmed, no whitespace-only names, emoji, or punctuation. Voluntary change no more often than every **168 hours**. Staff-required correction exempt.
- Voluntary deletion: immediately hide account-associated profile/social/messages; enter **30-day pending deletion**. Sign-in alone does not cancel. Explicit **Cancel Deletion** within 30 days restores; afterward final deletion. **No voluntary temporary-deactivation feature.**
- New registration after deletion permitted if not banned/evasion, but **nothing transfers** (PP, badges, stats, achievements, assets, etc.). Old usernames stay reserved; prior survey answers remain counted and cannot be repeated. Engineer privacy/legal-compliant minimal participation uniqueness records.

## 11. Profiles, pictures, social identity, and visibility
- Profiles show @username, optional display name, optional bio, profile photo/default avatar, badges, join date, selected stats/achievements, and approved created polls. Survey response history is private.
- Profile picture: optional; accepted JPG/JPEG, PNG, HEIC/HEIF, WebP, AVIF; reject animations. Maximum **15 MB**, minimum **200x200 pixels**. Validate file signatures/magic bytes, decode safely, cap resource use, resize/optimize, remove EXIF/GPS, and publish processed version only.
- Upload UI: free-form cropping, zoom, reposition, and live circle/profile preview. Last **successful upload** starts **168-hour cooldown**. Removing photo anytime does **not** reset/restart the timer; next upload allowed only after elapsed time. Rejected uploads do not start cooldown; staff-required correction exempt.
- Automated clearly prohibited photo rejection; borderline images staff review while current photo remains. Urgent moderation 24h review target; escalation to Super Moderator at 48h, Admin at 72h, then Owner. Log staff removals.
- Social links: choose from approved platform dropdown, one handle per platform; profile displays platform logo, with external-link warning/Confirm/Cancel and new-tab opening. Visibility Everyone/Friends/Nobody. No links in bio. Scan/sanitize links and bios.
- Online/away/DND/invisible presence; no precise last-online timestamp. Privacy settings for friends, requests, DMs, invites, online visibility, and friend lists.

## 12. Friends, followers, blocking, and messaging
- Friends are mutual; followers one-way. Respect visibility and request/invite privacy.
- One-way block: blocked person cannot see blocker's profile/content (photo, bio, badges, stats, socials, friends) or contact/interact with blocker. Settings > Privacy > Blocked Users supports viewing and unblocking; unblocking does not restore friendship/follow automatically.
- Existing shared group chat may remain, but messages from blocked person are hidden to blocker behind placeholder/reveal; blocked person cannot mention, reply to, or react to blocker. Group admins cannot override site-level block. No notification of blocked contact attempts. Protect against alt harassment.
- DMs and group messages: text, emoji, GIFs, replies, reactions, edit/delete. **No image/video/file uploads, attachments, or voice/video at launch.** Group owners/mods are not site staff. Staff access to DMs requires specifically authorized documented investigation and audited access.

## 13. Account states and retention boundaries
- **Frozen:** temporarily hide account-associated profile, messages, and social content from other users; restore if unfrozen.
- **Banned:** account-associated content disappears permanently from ordinary public view, potentially restored if overturned.
- **Deletion pending/final:** hide account-associated content immediately on request; cancel within 30 days restores, final deletion follows retention/privacy policy.
- In all three states, **legitimate poll questions and legitimate survey answers remain** in the survey system and aggregates; do not erase them solely because creator/respondent was sanctioned or deleted. Remove attribution as appropriate. Staff retain lawful moderation evidence and audit records according to retention policy. Do not show public “Deleted User” placeholders for hidden messages.
- Define separate data classes for account-associated content, independent poll/question content, anonymized survey aggregates, participation uniqueness tokens, and confidential evidence; apply state transitions to the correct class only.

## 14. Staff structure, powers, and records
- Rank hierarchy: **Owner > Admin > Super Moderator > Moderator > Trainee**. Owner is final authority, unrestricted within product design, and cannot be reported, investigated, or punished by subordinate staff.
- Admin oversees lower ranks sitewide and can access other Admin staff records as specified, but **only Owner promotes/demotes**. Super Moderator supervises Moderator/Trainee wings; Moderator supervises Trainees. Actions against staff require proper superior rank and wing/jurisdiction; appeals go to impartial staff at least one rank above original decision.
- Confidential Staff Records, append-only action history (actor, target, reason, evidence, before/after, time), and Owner-only sensitive-access audit. No export of confidential Staff Records.
- Staff may remove any confirmed violating content within permissions, with recorded reasons/evidence. No need to ask product owner for separate permission per content type; follow established role limits and audit.
- Reporter sees only **“Report submitted”**, without investigation status or follow-up. Accused is not notified of report filing, only actual action. Mandatory warning acknowledgment and correction at next sign-in when staff removes violating content.

## 15. Reporting, urgent safety, and anti-abuse
- Report categories cover inappropriate profiles/content, harassment, hate, threats, scams, spam, cheating, doxxing, underage, and other; “Other” free-text maximum **500 characters**.
- Cheating match reports may be filed during match or within **7 days**; general reports do not inherit this seven-day cutoff. Good-faith unsubstantiated reports are not punishable; knowingly fabricated malicious reports may be.
- Serious urgent reports concerning profiles, public interactions, threats, and harassment route to **first available qualified, nonconflicted staff member regardless of wing**. Target initial review within 24h; escalate at 48h to Super Moderator, 72h to Admin, then Owner. Immediate threats highest priority.
- Pending investigation, authorized staff can temporarily hide content, restrict contact, and protect exposed personal information; mandatory review within 24h, documented extensions every 24h, automatic escalation if overdue, and no automatic unhide when a credible immediate threat remains. Protective measures do not presume guilt.
- Repeat-offender escalation based on **confirmed** behavior, severity, recency, and evidence, not raw report volume. Block circumvention through alternate accounts, group messages, invitations, or DMs is separately actionable.

## 16. Cheating investigations, penalties, and appeals
- Automatic detection produces flags, **not automatic guilt**. A documented reasonable basis for formal cheating investigation temporarily suspends **all guessing gameplay** (solo, Daily guessing if ever added, and multiplayer) until resolved; ordinary survey responses remain allowed unless answer manipulation is implicated. Use neutral user-facing message.
- Investigation handoff/escalation every **48 hours** from Moderator to Super Moderator to Admin to Owner; original clock is not reset. Recuse conflicts. Review relevant games and only legally/role-authorized DM evidence; retain evidence despite account deletion where lawful.
- Confirmed alternate-account cheating may permanently ban verified linked accounts. Invalidate cheated matches, correct innocent users' win/loss records, and do not award forfeit wins. Played poll state remains; legitimate survey answers remain.
- New proven misconduct can increase proportionate sanction with appended evidence and updated remaining duration, but do not punish twice for same offense. Appeals/reopening require new evidence and higher-rank impartial review.

## 17. Leaderboards, statistics, badges, and achievements
- Public leaderboards exist at launch without ranked matchmaking or a formal rating system. Expose only legitimate server-calculated competition statistics and outcomes; do not count aborted/no-winner matches as wins/losses.
- User can toggle **leaderboard anonymity**. Their score/rank stays on leaderboard, but name displays **Anonymous**. This setting is separate from poll creator anonymity and profile visibility.
- Profile may display selected statistics, badges, and achievements. The exact leaderboard scoring formula, badge catalog, and achievement thresholds are **not specified here**; do not invent permanent economies, pay-to-win advantages, or formal ranked ratings. Implement extensible definitions and seek approval before committing scoring/reward rules.

## 18. Notifications and user-facing states
- Daily Poll in-app announcement once per day, individually toggleable in settings.
- Poll creator receives only approval/go-live notification linking to answer; no response milestone spam.
- Relevant moderation action notices and mandatory warning acknowledgment; no report-status notifications or notification when blocked contact is attempted.
- Clearly distinguish survey completion, PP progress, PP award, proposal acceptance/rejection/refund, poll unavailable, gameplay failure, match pause, reconnection, draw, and moderation restrictions.
- Avoid exposing full answer distributions, confidential reports, other people's private survey histories, or moderation evidence via notifications, APIs, analytics, or error messages.

## 19. Engineering architecture and security requirements
- Build with explicit domains/entities for Users, Credentials/Invites, Profiles, Relationships/Blocks, Messages, PollProposals, DailyQueue/Schedule, SurveyResponses, AnswerGroups, ResultSnapshots, DailyAssignments/Progress, PPLedger, GameSessions, MultiplayerMatches, SpectatorPermissions, Reports/Cases, StaffActions, Evidence, Notifications, and Audits.
- Enforce permissions **server-side** for every route, subscription, event, job, and API. Never trust UI-hidden controls, user-provided role, guess count, PP balance, snapshot ID, poll selection, or match timer.
- Database uniqueness constraints and transactions for one-response-per-person-per-poll, code redemption, daily PP issuance, PP spend/refund, first accepted guess played-state, and match votes/actions. Retry-safe idempotency keys and concurrency tests.
- Separate immutable/append-only moderation and PP audit logs from user-editable data. Restrict evidence and staff records with least privilege and access logging. Encrypt sensitive data in transit/at rest; protect session lifecycle, account recovery, CSRF, XSS, SQL injection, SSRF, rate limits, bots, and mass assignment.
- Validate user-generated text, media, external social handles/URLs, and Unicode/ASCII rules at both client and server. Strip photo metadata, verify actual image formats, enforce worker/time/memory limits, and prevent upload denial of service.
- Snapshot computation every 24 hours; freeze a snapshot per match; use versioned normalization rules and consistent denominators. Ensure no gameplay before 100 valid respondents and feasibility gate.
- Model multiplayer as an explicit state machine: lobby/matching, active, manual-pause vote, disconnect vote, protected reconnect, paused, ready, vote-to-continue, technical-pause, completed, draw/aborted. Specify server timestamps, quorum calculations, race handling, reconnect, duplicate events, and terminal-state idempotency.
- Privacy by design: separate personal identifiers from public aggregate survey answers; preserve only the minimum legal participation-deduplication proof needed after deletion. Define lawful retention and deletion policy with qualified review before launch.
- Production operations: migrations with rollback strategy, backups and tested restores, observability with scrubbed logs, alerting for Daily Poll queue exhaustion, stuck matches, delayed snapshot jobs, suspicious PP issuance, upload abuse, and staff escalation deadlines.
- Accessibility, mobile-responsive UI, keyboard navigation, screen-reader labels, reduced-motion handling, international/timezone-safe dates, and clear error states.

## 20. Launch sequence and acceptance tests
### Recommended implementation phases (planning order, not a claim of existing work)
1. Foundation: authentication, invite-only beta, email verification, roles, database migrations, audit/security baseline.
2. Poll proposals, moderation queues, zero-response Daily Poll queue, calendar/automatic selection, timezone-safe publication.
3. Survey submission, anti-duplicate identity rules, 10 daily assignments, daily progress and atomic PP ledger.
4. Answer grouping, 24-hour snapshots, eligibility/feasibility engine, solo guessing and played-poll history.
5. Multiplayer matchmaking/rooms, server state machine, spectator-safe feeds, private pauses, disconnect recovery, Vote to Continue, outage recovery.
6. Profiles, picture pipeline, friends/followers, blocking, messaging, notification settings, anonymity, leaderboards.
7. Reports, staff wings/records, emergency protection, cheating investigations, appeals, deletion/freeze/ban state handling.
8. Load, security, concurrency, accessibility, moderation, privacy, backup/restore, and invite-only beta validation.

### Non-negotiable acceptance tests
- New approved question cannot collect any response before its Daily Poll debut; no question bypasses queue; no repeat Daily Poll.
- Daily Poll starts at zero; prior Daily Poll becomes existing survey; 100-respondent gate affects guessing only.
- 11 distinct eligible daily responses issue exactly 1 PP, even with retries/midnight races; 10 or fewer issue zero.
- One permanent response per person/poll, including concurrent requests and re-registration; no fabricated votes.
- Solo gameplay never counts toward daily survey quota; viewing/answering never marks played; first accepted guess does.
- 60% goal, 3 strikes, 10–20 distribution-dependent guesses, duplicate-guess neutrality, 30-day plus substantive-change replay gate.
- Frozen snapshot identical for all match participants; no secret answers leaked to opponents or spectators.
- Private pause quorum/limits, disconnect protection, unanimous Vote to Continue, Ready gating, outage draw and no forfeit wins all survive disconnect/race tests.
- 7-day display-name/picture timers exact; photo removal does not restart upload timer; username permanent reservation.
- Global/per-poll anonymity restores correctly; leaderboard Anonymous retains ranking and score.
- Frozen/banned/deleted user content hides correctly while legitimate poll questions and survey aggregates persist.
- Blocked people cannot access protected profile data through direct APIs, cached feeds, DMs, mentions, or alternate endpoints.
- Staff rank, conflict, escalation, audit, PP refund, evidence access, and cheating review rules enforced server-side.
- Invites atomically redeemed only on successful registration; expiration/revocation/use caps enforced.
- Backups restore successfully; jobs resume safely; production logs contain no secrets or sensitive response contents.

## 21. Decisions NOT to invent during implementation
The following are not fully fixed in this handoff and must be surfaced as short explicit proposals only if essential to build the relevant component: exact algorithm mapping answer distribution to the 10–20 guess cap; numerical definition of “substantial” result changes for replay; exact leaderboard point formula, achievements, badge catalog; minimum player count for each multiplayer mode; edge behavior of approved reconnect pauses after private pause quota exhausted; treatment of already-completed Daily Poll credit after an emergency mid-day replacement; detailed content-policy wording and legally required retention periods. Do not reinterpret settled gameplay, daily queue, anonymity, privacy, or moderation rules to fill these gaps.

## 22. Instructions to the next GPT / Claude
Treat this document as the **single source of truth for The People Poll's agreed product behavior**. First perform a contradiction/dependency audit and list only genuine unresolved decisions from §21 or actual technical impossibilities; do not reopen established choices. Then produce an architecture and phased implementation plan with database schema, authorization matrix, state machines, API/event contracts, migrations, abuse controls, and test cases. Make changes in small reviewable batches; report files changed, migrations, tests run, failures, and risks. Do not claim features are implemented without inspecting the actual repository. Do not silently substitute simpler behavior for the stated requirements. Do not borrow requirements from any other product, conversation, or repository unless explicitly supplied for this project.
