import type { Role } from '@pplpoll/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { errors } from '../core/errors.js';
import { atLeast } from '../core/roles.js';
import type { SessionUser } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: SessionUser | null;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Requires a signed-in user; on state-changing methods also requires the session's CSRF token. */
export async function requireUser(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.auth) throw errors.unauthenticated();
  if (!SAFE_METHODS.has(req.method) && req.headers['x-csrf-token'] !== req.auth.csrfToken) {
    throw errors.csrf();
  }
}

/** Role check is server-side and uses the role stored in the database, never client input. */
export function requireRole(minimum: Role) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await requireUser(req, reply);
    if (!atLeast(req.auth!.role, minimum)) throw errors.forbidden();
  };
}

export function currentUser(req: FastifyRequest): SessionUser {
  if (!req.auth) throw errors.unauthenticated();
  return req.auth;
}
