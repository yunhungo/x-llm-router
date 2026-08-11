import { beforeEach, describe, expect, it } from 'vitest';

import { resetConfigForTests } from '../config';
import {
  decryptLangfuseSettings,
  encryptLangfuseSettings,
  publicLangfuseSettings,
  type KeyLangfuseSettings,
} from './langfuse';

describe('per-key Langfuse settings', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://example';
    process.env.ENCRYPTION_KEY = 'test-encryption-key-with-enough-length';
    process.env.JWT_SECRET = 'test-jwt-secret-with-enough-length';
    resetConfigForTests();
  });

  it('encrypts the complete project configuration', () => {
    const settings: KeyLangfuseSettings = {
      enabled: true,
      publicKey: 'pk-lf-project',
      secretKey: 'sk-lf-secret',
      baseUrl: 'https://cloud.langfuse.com',
      environment: 'production',
      traceName: 'gateway-request',
      version: '2026.08.11',
      tags: ['gateway', 'paid'],
      metadata: { tenant: 'acme' },
      userIdHeader: 'x-user-id',
      sessionIdHeader: 'x-session-id',
      captureInput: false,
      captureOutput: true,
    };
    const encrypted = encryptLangfuseSettings(settings);

    expect(encrypted).not.toContain(settings.secretKey);
    expect(decryptLangfuseSettings(encrypted)).toEqual(settings);
  });

  it('never exposes the secret key to the admin UI', () => {
    const settings = decryptLangfuseSettings(
      encryptLangfuseSettings({
        enabled: true,
        publicKey: 'pk-lf-project',
        secretKey: 'sk-lf-secret',
        baseUrl: 'https://cloud.langfuse.com',
        environment: 'production',
        traceName: '',
        version: '',
        tags: [],
        metadata: {},
        userIdHeader: 'x-user-id',
        sessionIdHeader: 'x-session-id',
        captureInput: false,
        captureOutput: false,
      }),
    );

    expect(publicLangfuseSettings(settings)).toMatchObject({
      publicKey: 'pk-lf-project',
      hasSecretKey: true,
      captureInput: false,
      captureOutput: false,
    });
    expect(JSON.stringify(publicLangfuseSettings(settings))).not.toContain('sk-lf-secret');
  });
});
