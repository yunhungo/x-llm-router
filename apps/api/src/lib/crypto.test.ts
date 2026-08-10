import { beforeEach, describe, expect, it } from 'vitest';

import { resetConfigForTests } from '../config';
import { createVirtualApiKey, decryptJson, encryptJson, hashApiKey } from './crypto';

describe('credential crypto', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://example';
    process.env.ENCRYPTION_KEY = 'test-encryption-key-with-enough-length';
    process.env.JWT_SECRET = 'test-jwt-secret-with-enough-length';
    resetConfigForTests();
  });

  it('round-trips encrypted JSON without exposing plaintext', () => {
    const encrypted = encryptJson({ accessToken: 'secret-token' });
    expect(encrypted).not.toContain('secret-token');
    expect(decryptJson(encrypted)).toEqual({ accessToken: 'secret-token' });
  });

  it('generates a one-way virtual API key', () => {
    const key = createVirtualApiKey();
    expect(key.rawKey).toMatch(/^xr_/);
    expect(key.hash).toBe(hashApiKey(key.rawKey));
    expect(key.hash).not.toContain(key.rawKey);
  });
});
