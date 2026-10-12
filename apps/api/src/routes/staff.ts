import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, requireRole } from '../auth/guards.js';
import type { AppDeps } from '../core/deps.js';
import { ROLES } from '../core/roles.js';
import { parse } from '../core/validate.js';
import * as invites from '../modules/invites/service.js';
import { changeRole } from '../modules/staff/roles.js';

const CreateInvite = z.strictObject({
  maxUses: z.number().int().min(1).max(10_000),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  label: z.string().trim().min(1).max(100).nullable().optional(),
});
const IdParam = z.strictObject({ id: z.uuid() });
const RoleBody = z.strictObject({ role: z.enum(ROLES as [string, ...string[]]) });

export function registerStaffRoutes(app: FastifyInstance, deps: AppDeps): void {
  // Invite management is Owner-only (spec §10).
  const owner = { preHandler: requireRole('owner') };

  app.post('/staff/invites', owner, async (req, reply) => {
    const body = parse(CreateInvite, req.body);
    const created = await invites.createInvite(deps, currentUser(req).userId, {
      maxUses: body.maxUses,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      label: body.label ?? null,
    });
    return reply.code(201).send(created);
  });

  app.get('/staff/invites', owner, async () => ({ invites: await invites.listInvites(deps) }));

  app.get('/staff/invites/:id/redemptions', owner, async (req) => {
    const { id } = parse(IdParam, req.params);
    return { redemptions: await invites.listRedemptions(deps, id) };
  });

  app.post('/staff/invites/:id/revoke', owner, async (req) => {
    const { id } = parse(IdParam, req.params);
    await invites.revokeInvite(deps, currentUser(req).userId, id);
    return { revoked: true };
  });

  app.put('/staff/users/:id/role', owner, async (req) => {
    const { id } = parse(IdParam, req.params);
    const { role } = parse(RoleBody, req.body);
    await changeRole(deps, currentUser(req).userId, id, role as (typeof ROLES)[number]);
    return { role };
  });
}
