/**
 * One-time bootstrap of the Owner account (the Owner then creates invite codes).
 * Usage: OWNER_EMAIL=... OWNER_USERNAME=... OWNER_PASSWORD=... pnpm --filter @pplpoll/api owner:create
 */
import { createDb } from '@pplpoll/db';
import {
  isAcceptablePassword,
  isPlausibleEmail,
  isValidUsername,
  normalizeEmail,
} from '@pplpoll/domain';
import { audit } from '../core/audit.js';
import { Crypto, loadSecrets } from '../core/crypto.js';
import type { AppDeps } from '../core/deps.js';
import { createLogger } from '../logger.js';
import { insertAccount } from '../modules/accounts/service.js';

const { OWNER_EMAIL = '', OWNER_USERNAME = '', OWNER_PASSWORD = '', DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!isPlausibleEmail(normalizeEmail(OWNER_EMAIL))) throw new Error('OWNER_EMAIL is invalid');
if (!isValidUsername(OWNER_USERNAME)) throw new Error('OWNER_USERNAME must be 3-20 letters/digits');
if (!isAcceptablePassword(OWNER_PASSWORD))
  throw new Error('OWNER_PASSWORD must be 10-128 characters');

const deps: AppDeps = {
  db: createDb(DATABASE_URL),
  logger: createLogger(),
  crypto: new Crypto(loadSecrets()),
  clock: () => new Date(),
  secureCookies: true,
  authRateLimit: { max: 10, timeWindowMs: 60_000 },
};

try {
  const now = deps.clock();
  const id = await deps.db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('users')
      .select('id')
      .where('role', '=', 'owner')
      .executeTakeFirst();
    if (existing) throw new Error('An Owner already exists');
    const userId = await insertAccount(
      trx,
      deps,
      {
        email: OWNER_EMAIL,
        password: OWNER_PASSWORD,
        username: OWNER_USERNAME,
        displayName: null,
        role: 'owner',
        verified: true,
      },
      now,
    );
    await audit(trx, {
      actor: null,
      action: 'owner.bootstrap',
      targetType: 'user',
      targetId: userId,
    });
    return userId;
  });
  process.stdout.write(`Owner created: ${id}\n`);
} finally {
  await deps.db.destroy();
}
