import {
  isAcceptablePassword,
  isPlausibleEmail,
  isValidUsername,
  normalizeDisplayName,
  normalizeEmail,
} from '@pplpoll/domain';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { currentUser, requireUser } from '../auth/guards.js';
import { SESSION_COOKIE, SESSION_TTL_MS } from '../auth/sessions.js';
import type { AppDeps } from '../core/deps.js';
import { parse } from '../core/validate.js';
import * as accounts from '../modules/accounts/service.js';
import { checkInvite } from '../modules/invites/service.js';

const email = z
  .string()
  .max(254)
  .refine((v) => isPlausibleEmail(normalizeEmail(v)));
const password = z.string().refine(isAcceptablePassword);
const displayName = z
  .string()
  .max(100)
  .transform((v, ctx) => {
    const r = normalizeDisplayName(v);
    if (!r.ok) {
      ctx.addIssue({ code: 'custom', message: 'invalid display name' });
      return z.NEVER;
    }
    return r.value;
  });

const RegisterBody = z.strictObject({
  inviteCode: z.string().min(1).max(64),
  email,
  password,
  username: z.string().refine(isValidUsername),
  displayName: displayName.nullable().optional(),
});
const LoginBody = z.strictObject({ email: z.string().max(254), password: z.string().max(256) });
const TokenBody = z.strictObject({ token: z.string().min(10).max(200) });
const EmailBody = z.strictObject({ email: z.string().max(254) });
const InviteCheckBody = z.strictObject({ code: z.string().min(1).max(64) });

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const limited = {
    config: {
      rateLimit: { max: deps.authRateLimit.max, timeWindow: deps.authRateLimit.timeWindowMs },
    },
  };

  const setSessionCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: deps.secureCookies,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    });

  app.post('/auth/invite/check', limited, async (req) => {
    const { code } = parse(InviteCheckBody, req.body);
    return { valid: await checkInvite(deps, code) };
  });

  app.post('/auth/register', limited, async (req, reply) => {
    const body = parse(RegisterBody, req.body);
    const { userId } = await accounts.register(deps, {
      ...body,
      displayName: body.displayName ?? null,
    });
    return reply.code(201).send({ userId, verificationRequired: true });
  });

  app.post('/auth/verify-email', limited, async (req) => {
    const { token } = parse(TokenBody, req.body);
    await accounts.verifyEmail(deps, token);
    return { verified: true };
  });

  app.post('/auth/verify-email/resend', limited, async (req, reply) => {
    const { email: e } = parse(EmailBody, req.body);
    await accounts.resendVerification(deps, e);
    return reply
      .code(202)
      .send({ message: 'If that account needs verification, an email is on its way' });
  });

  app.post('/auth/login', limited, async (req, reply) => {
    const body = parse(LoginBody, req.body);
    const result = await accounts.login(deps, body.email, body.password);
    setSessionCookie(reply, result.token);
    return { userId: result.userId, csrfToken: result.csrfToken, reactivated: result.reactivated };
  });

  app.post('/auth/logout', { preHandler: requireUser }, async (req, reply) => {
    await accounts.logout(deps, currentUser(req).sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  /** Background session check. Never reactivates an account. */
  app.get('/auth/session', { preHandler: requireUser }, async (req) => {
    const auth = currentUser(req);
    return { user: await accounts.getMe(deps, auth.userId), csrfToken: auth.csrfToken };
  });
}

export const schemas = { displayName, password };
