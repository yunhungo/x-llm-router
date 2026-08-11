import { beforeEach, describe, expect, it } from 'vitest';

import { setRuntimeSecretsForTests } from '../runtime-secrets';
import { createVirtualApiKey, decryptJson, encryptJson, hashApiKey } from './crypto';

describe('credential crypto', () => {
  beforeEach(() => {
    setRuntimeSecretsForTests({
      ENCRYPTION_KEY: 'test-encryption-key-with-enough-length',
      JWT_SECRET: 'test-jwt-secret-with-enough-length',
    });
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
