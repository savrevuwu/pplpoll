import type { AccountState, Visibility } from '@pplpoll/db';

/**
 * Public creator attribution (spec §9, §13). Shown only when the poll was submitted as public,
 * the creator's global "Hide my name on all polls" switch is off, and the account is active.
 * Staff can always identify creators through staff endpoints.
 */
export function publicCreator(p: {
  visibility: Visibility;
  username: string | null;
  hideAll: boolean | null;
  state: AccountState | null;
}): string | null {
  if (p.visibility !== 'public' || p.hideAll || p.state !== 'active') return null;
  return p.username;
}
