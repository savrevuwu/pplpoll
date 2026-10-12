# Authorization Matrix (PROPOSAL)

Enforced server-side on every HTTP route, WebSocket subscription/event, and job. UI hiding is never relied on.
Legend: ✅ allowed · ❌ denied · 🔸 conditional (see note) · Self = own resource only.

Ranks: Owner > Admin > Super Moderator > Moderator > Trainee > Member > Public (signed out).

| Action                                          | Public | Member | Trainee | Moderator | Super Mod | Admin | Owner                        |
| ----------------------------------------------- | ------ | ------ | ------- | --------- | --------- | ----- | ---------------------------- |
| Register with invite code                       | ✅     | —      | —       | —         | —         | —     | —                            |
| Create / revoke / monitor invite codes          | ❌     | ❌     | ❌      | ❌        | ❌        | ❌    | ✅                           |
| View profile                                    | ❌     | 🔸¹    | 🔸¹     | ✅²       | ✅²       | ✅²   | ✅                           |
| Edit own profile / display name / photo         | ❌     | Self³  | Self³   | Self³     | Self³     | Self³ | Self³                        |
| Answer Daily Poll / assigned surveys            | ❌     | ✅⁴    | ✅⁴     | ✅⁴       | ✅⁴       | ✅⁴   | ✅⁴                          |
| Play solo / multiplayer                         | ❌     | ✅⁵    | ✅⁵     | ✅⁵       | ✅⁵       | ✅⁵   | ✅⁵                          |
| Choose a game poll                              | ❌     | ❌     | ❌      | ❌        | ❌        | ❌    | ❌                           |
| Spectate                                        | ❌     | 🔸⁶    | 🔸⁶     | 🔸⁶       | 🔸⁶       | 🔸⁶   | 🔸⁶                          |
| Submit poll proposal (1 PP)                     | ❌     | ✅     | ✅      | ✅        | ✅        | ✅    | ✅                           |
| Review proposals (approve/reject/edit/refund)   | ❌     | ❌     | 🔸⁷     | ✅        | ✅        | ✅    | ✅                           |
| Correct a mistaken refund                       | ❌     | ❌     | ❌      | ❌        | ✅        | ✅    | ✅                           |
| Edit Daily Poll calendar                        | ❌     | ❌     | ❌      | ❌        | ❌        | ✅    | ✅                           |
| Emergency Daily Poll replacement                | ❌     | ❌     | ❌      | ❌        | ❌        | ✅    | ✅                           |
| Read raw survey responses (quality review)      | ❌     | ❌     | ❌      | ✅⁸       | ✅⁸       | ✅⁸   | ✅⁸                          |
| Remove prohibited response / content            | ❌     | ❌     | 🔸⁷     | ✅        | ✅        | ✅    | ✅                           |
| See full answer distribution                    | ❌     | ❌     | ❌      | ✅⁸       | ✅⁸       | ✅⁸   | ✅⁸                          |
| Identify anonymous poll creator                 | ❌     | ❌     | ✅      | ✅        | ✅        | ✅    | ✅                           |
| File report                                     | ❌     | ✅     | ✅      | ✅        | ✅        | ✅    | — (Owner cannot be reported) |
| Handle reports / cases                          | ❌     | ❌     | 🔸⁷     | ✅⁹       | ✅⁹       | ✅⁹   | ✅                           |
| Freeze / ban members                            | ❌     | ❌     | ❌      | ✅⁹       | ✅⁹       | ✅⁹   | ✅                           |
| Action against staff                            | ❌     | ❌     | ❌      | 🔸¹⁰      | 🔸¹⁰      | 🔸¹⁰  | ✅                           |
| Promote / demote staff                          | ❌     | ❌     | ❌      | ❌        | ❌        | ❌    | ✅                           |
| Read Staff Records                              | ❌     | ❌     | ❌      | 🔸¹⁰      | 🔸¹⁰      | ✅¹¹  | ✅                           |
| Export Staff Records                            | ❌     | ❌     | ❌      | ❌        | ❌        | ❌    | ❌                           |
| Read sensitive-access audit                     | ❌     | ❌     | ❌      | ❌        | ❌        | ❌    | ✅                           |
| Access DMs as evidence                          | ❌     | ❌     | ❌      | 🔸¹²      | 🔸¹²      | 🔸¹²  | 🔸¹²                         |
| Decide appeal                                   | ❌     | ❌     | ❌      | 🔸¹³      | 🔸¹³      | 🔸¹³  | ✅                           |
| Open cheating investigation (suspends guessing) | ❌     | ❌     | ❌      | ✅⁹       | ✅⁹       | ✅⁹   | ✅                           |

Notes

1. Subject to target's privacy settings and blocks (blocked users get 404-equivalent, never a "blocked" hint). Hidden if target is frozen/banned/deactivated.
2. Staff view within role for moderation; access to hidden content is audit-logged.
3. Display name ≥168 h between voluntary changes; photo upload ≥168 h after last successful upload; staff-required corrections exempt.
4. Not while frozen/banned/deactivated. Survey answering continues during a cheating investigation unless answer manipulation is implicated.
5. Blocked during an active cheating investigation; subject to 10 daily charges and one active game.
6. Private rooms: host-controlled. Public/Versus: pending decision Q5. Blocks always apply.
7. Trainee actions require supervising Moderator confirmation (proposal: trainee actions are drafted then confirmed).
8. Restricted-role DB access; every read written to `sensitive_access_log`.
9. Within wing/jurisdiction; urgent safety cases go to first available qualified, nonconflicted staff regardless of wing. Conflicted staff are recused automatically.
10. Only a superior rank with jurisdiction: Moderator → Trainee in own wing; Super Mod → Moderator/Trainee in own wings; Admin → all lower ranks sitewide.
11. Admin may read other Admin staff records as specified.
12. Only with a documented, authorized investigation record; access audited (legal dependency L3).
13. Impartial reviewer at least one rank above original decision maker; requires new evidence to reopen.

Relationship-scoped rules (all roles as members): blocked users cannot view blocker profile/content, DM, mention, reply, react, invite, follow, or be matched in future games with the blocker.
