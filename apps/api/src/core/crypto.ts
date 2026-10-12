import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * Application-level encryption and keyed hashing.
 * - `encrypt`/`decrypt`: AES-256-GCM for sensitive values at rest (emails, invite codes, email payloads).
 * - `lookup`: HMAC-SHA256 with a purpose label, for equality lookups without storing plaintext.
 * Keys come from the environment / secret store, never from the repository.
 */
export interface Secrets {
  encryptionKey: Buffer; // 32 bytes
  hmacKey: Buffer; // >= 32 bytes
}

export function loadSecrets(env: NodeJS.ProcessEnv = process.env): Secrets {
  const enc = Buffer.from(env.APP_ENCRYPTION_KEY ?? '', 'base64');
  const mac = Buffer.from(env.APP_HMAC_KEY ?? '', 'base64');
  if (enc.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  if (mac.length < 32) throw new Error('APP_HMAC_KEY must be at least 32 bytes, base64-encoded');
  return { encryptionKey: enc, hmacKey: mac };
}

export class Crypto {
  constructor(private readonly secrets: Secrets) {}

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.secrets.encryptionKey, iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      body.toString('base64'),
    ].join('.');
  }

  decrypt(token: string): string {
    const [version, iv, tag, body] = token.split('.');
    if (version !== 'v1' || !iv || !tag || body === undefined) throw new Error('Bad ciphertext');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.secrets.encryptionKey,
      Buffer.from(iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString(
      'utf8',
    );
  }

  lookup(purpose: string, value: string): string {
    return createHmac('sha256', this.secrets.hmacKey)
      .update(`${purpose}\0${value}`)
      .digest('base64url');
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}
