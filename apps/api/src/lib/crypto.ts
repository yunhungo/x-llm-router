import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

import { getConfig } from '../config';

const VERSION = 'v1';

function encryptionKey(): Buffer {
  return createHash('sha256').update(getConfig().ENCRYPTION_KEY, 'utf8').digest();
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptJson<T>(payload: string): T {
  const [version, ivPart, tagPart, ciphertextPart] = payload.split('.');
  if (version !== VERSION || !ivPart || !tagPart || !ciphertextPart) {
    throw new Error('Unsupported encrypted payload format');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivPart, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}

export function hashApiKey(rawKey: string): string {
  return createHmac('sha256', encryptionKey()).update(rawKey, 'utf8').digest('hex');
}

export function createVirtualApiKey(): { rawKey: string; prefix: string; hash: string } {
  const rawKey = `xr_${randomBytes(32).toString('base64url')}`;
  return {
    rawKey,
    prefix: `${rawKey.slice(0, 11)}…`,
    hash: hashApiKey(rawKey),
  };
}
