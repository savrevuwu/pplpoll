import type { Role } from '@pplpoll/db';
import { audit } from '../../core/audit.js';
import type { AppDeps } from '../../core/deps.js';
import { AppError, errors } from '../../core/errors.js';

/**
 * Only the Owner promotes or demotes (spec §14). The Owner role itself can't be granted or removed
 * through the API, and nobody changes their own role.
 */
export async function changeRole(deps: AppDeps, actorId: string, targetId: string, newRole: Role) {
  if (newRole === 'owner') throw errors.forbidden();
  if (actorId === targetId)
    throw new AppError(409, 'CANNOT_CHANGE_OWN_ROLE', 'You cannot change your own role');
  await deps.db.transaction().execute(async (trx) => {
    const actor = await trx
      .selectFrom('users')
      .select('role')
      .where('id', '=', actorId)
      .forShare()
      .executeTakeFirst();
    if (actor?.role !== 'owner') throw errors.forbidden();
    const target = await trx
      .selectFrom('users')
      .select(['role', 'state'])
      .where('id', '=', targetId)
      .forUpdate()
      .executeTakeFirst();
    if (!target || target.state === 'deleted') throw errors.notFound();
    if (target.role === 'owner') throw errors.forbidden();
    if (target.role === newRole) return;
    await trx.updateTable('users').set({ role: newRole }).where('id', '=', targetId).execute();
    await audit(trx, {
      actor: actorId,
      action: 'staff.role_change',
      targetType: 'user',
      targetId,
      detail: { before: target.role, after: newRole },
    });
  });
}
