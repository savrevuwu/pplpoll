import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, requireUser } from '../auth/guards.js';
import { SESSION_COOKIE } from '../auth/sessions.js';
import type { AppDeps } from '../core/deps.js';
import { errors } from '../core/errors.js';
import { parse } from '../core/validate.js';
import * as accounts from '../modules/accounts/service.js';
import { playerStats } from '../modules/stats/service.js';
import { schemas } from './auth.js';

const ProfileBody = z.strictObject({ displayName: schemas.displayName.nullable() });
const DeactivateBody = z.strictObject({ password: z.string().max(256) });

export function registerAccountRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/me', { preHandler: requireUser }, async (req) =>
    accounts.getMe(deps, currentUser(req).userId),
  );

  app.patch('/me/profile', { preHandler: requireUser }, async (req) => {
    const { displayName } = parse(ProfileBody, req.body);
    await accounts.updateDisplayName(deps, currentUser(req).userId, displayName);
    return accounts.getMe(deps, currentUser(req).userId);
  });

  app.post('/account/deactivate', { preHandler: requireUser }, async (req, reply) => {
    const { password } = parse(DeactivateBody, req.body);
    const s = await accounts.deactivate(deps, currentUser(req).userId, password);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return {
      deactivated: true,
      lastReactivationDate: s.lastReactivationDate,
      message: 'Sign in any time before your deletion date to restore your account',
    };
  });

  app.get('/users/:username', { preHandler: requireUser }, async (req) => {
    const { username } = parse(z.strictObject({ username: z.string().max(20) }), req.params);
    const profile = await accounts.getPublicProfile(deps, username);
    if (!profile) throw errors.notFound();
    // Every profile shows Rarest Correct Guess (update §8) and the record badge (update §9).
    const stats = await playerStats(deps.db, profile.userId);
    return {
      username: profile.username,
      displayName: profile.displayName,
      joinedAt: profile.joinedAt,
      rarestCorrectGuess: stats.rarestCorrectGuess,
      rarestGuessRecordHolder: stats.rarestGuessRecordHolder,
    };
  });
}
