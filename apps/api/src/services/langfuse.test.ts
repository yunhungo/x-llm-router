import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setRuntimeSecretsForTests } from '../runtime-secrets';
import {
  decryptLangfuseSettings,
  encryptLangfuseSettings,
  publicLangfuseSettings,
  ReloadableLangfuseSpanProcessor,
  type KeyLangfuseSettings,
} from './langfuse';

function fakeProcessor() {
  return {
    onStart: vi.fn(),
    onEnd: vi.fn(),
    forceFlush: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  };
}

describe('per-key Langfuse settings', () => {
  beforeEach(() => {
    setRuntimeSecretsForTests({
      ENCRYPTION_KEY: 'test-encryption-key-with-enough-length',
      JWT_SECRET: 'test-jwt-secret-with-enough-length',
    });
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
      restartRequiredAfterSave: false,
    });
    expect(JSON.stringify(publicLangfuseSettings(settings))).not.toContain('sk-lf-secret');
  });

  it('keeps in-flight spans on the previous processor while switching new spans immediately', async () => {
    const runtime = new ReloadableLangfuseSpanProcessor();
    const previous = fakeProcessor();
    const replacement = fakeProcessor();
    const inFlightSpan = {};

    runtime.replaceKey('key-1', previous);
    runtime.onStart(inFlightSpan as never, {} as never);
    runtime.replaceKey('key-1', replacement);

    expect(previous.shutdown).not.toHaveBeenCalled();
    runtime.onEnd(inFlightSpan as never);
    await runtime.forceFlush();

    expect(previous.onEnd).toHaveBeenCalledWith(inFlightSpan);
    expect(replacement.onEnd).not.toHaveBeenCalledWith(inFlightSpan);
    expect(previous.forceFlush).toHaveBeenCalled();
    expect(previous.shutdown).toHaveBeenCalled();

    const nextSpan = {};
    runtime.onStart(nextSpan as never, {} as never);
    runtime.onEnd(nextSpan as never);
    expect(replacement.onStart).toHaveBeenCalledWith(nextSpan, {});
    expect(replacement.onEnd).toHaveBeenCalledWith(nextSpan);
    await runtime.shutdown();
  });

  it('flushes and shuts down an idle processor when its key is disabled', async () => {
    const runtime = new ReloadableLangfuseSpanProcessor();
    const processor = fakeProcessor();

    runtime.replaceKey('key-1', processor);
    runtime.replaceKey('key-1');
    await runtime.forceFlush();

    expect(processor.forceFlush).toHaveBeenCalledTimes(1);
    expect(processor.shutdown).toHaveBeenCalledTimes(1);
    await runtime.shutdown();
  });
});
