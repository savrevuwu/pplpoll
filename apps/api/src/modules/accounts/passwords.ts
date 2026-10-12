import { hash, verify } from '@node-rs/argon2';

// Argon2id with OWASP-recommended baseline parameters.
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export function verifyPassword(stored: string, password: string): Promise<boolean> {
  return verify(stored, password).catch(() => false);
}

let dummyHash: Promise<string> | undefined;

/** Spends the same work as a real check so unknown emails are not revealed by timing. */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('not-a-real-password-for-timing');
  await verifyPassword(await dummyHash, password);
}
