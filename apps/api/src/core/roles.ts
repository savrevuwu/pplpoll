import type { Role } from '@pplpoll/db';

/** Owner > Admin > Super Moderator > Moderator > Trainee > Member (spec §14). */
export const ROLE_RANK: Record<Role, number> = {
  member: 0,
  trainee: 1,
  moderator: 2,
  super_moderator: 3,
  admin: 4,
  owner: 5,
};

export const ROLES = Object.keys(ROLE_RANK) as Role[];

export function atLeast(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}
