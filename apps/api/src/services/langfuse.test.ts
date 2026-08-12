import { beforeEach, describe, expect, it, vi } from 'vitest';

import { langfuseSettingsSchema } from '@x-router/contracts';

import { setRuntimeSecretsForTests } from '../runtime-secrets';
import {
  checkLangfuseConnection,
  decryptLangfuseSettings,
  encryptLangfuseSettings,
  publicLangfuseSettings,
  ReloadableLangfuseSpanProcessor,
  safeTelemetryDiagnosticValue,
  isLangfuseDiagnosticsEnabled,
  safeLangfuseBaseUrlForDiagnostics,
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

function testSettings(overrides: Partial<KeyLangfuseSettings> = {}): KeyLangfuseSettings {
  return {
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
    captureInput: true,
    captureOutput: true,
    ...overrides,
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

  it('normalizes a trailing slash before the OTLP endpoint is composed', () => {
    const settings: KeyLangfuseSettings = {
      enabled: true,
      publicKey: 'pk-lf-project',
      secretKey: 'sk-lf-secret',
      baseUrl: 'https://langfuse.example.test///',
      environment: 'production',
      traceName: '',
      version: '',
      tags: [],
      metadata: {},
      userIdHeader: 'x-user-id',
      sessionIdHeader: 'x-session-id',
      captureInput: true,
      captureOutput: true,
    };

    expect(decryptLangfuseSettings(encryptLangfuseSettings(settings))?.baseUrl).toBe(
      'https://langfuse.example.test',
    );
  });

  it('allows request header mappings to be disabled with empty values', () => {
    const result = langfuseSettingsSchema.safeParse({
      enabled: false,
      publicKey: '',
      baseUrl: 'https://cloud.langfuse.com',
      environment: 'production',
      userIdHeader: '',
      sessionIdHeader: '',
    });

    if (!result.success) throw result.error;
    expect(result.data).toMatchObject({ userIdHeader: '', sessionIdHeader: '' });
  });

  it('tests Langfuse credentials against the project API without exposing them', async () => {
    const fetchMock = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response('{"data":[]}', {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
    );

    await expect(
      checkLangfuseConnection(
        testSettings({ baseUrl: 'https://us.cloud.langfuse.com/' }),
        fetchMock as unknown as typeof fetch,
      ),
    ).resolves.toEqual({
      ok: true,
      baseUrl: 'https://us.cloud.langfuse.com',
      statusCode: 200,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://us.cloud.langfuse.com/api/public/projects',
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'https://us.cloud.langfuse.com/api/public/otel/v1/traces',
    );
    const projectHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(projectHeaders.get('authorization')).toBe(
      `Basic ${Buffer.from('pk-lf-project:sk-lf-secret').toString('base64')}`,
    );
    const otlpHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(otlpHeaders.get('authorization')).toBe(projectHeaders.get('authorization'));
    expect(otlpHeaders.get('content-type')).toBe('application/x-protobuf');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBeInstanceOf(Uint8Array);
  });

  it('turns Langfuse authentication failures into an actionable safe error', async () => {
    const fetchMock = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response('{"message":"unauthorized"}', {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );

    await expect(
      checkLangfuseConnection(testSettings(), fetchMock as unknown as typeof fetch),
    ).rejects.toMatchObject({ statusCode: 400, code: 'langfuse_auth_failed' });
  });

  it('detects when the OTLP traces endpoint is missing behind a proxy', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"data":[]}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response('', { status: 404 }));

    await expect(
      checkLangfuseConnection(testSettings(), fetchMock as unknown as typeof fetch),
    ).rejects.toMatchObject({ statusCode: 400, code: 'langfuse_otlp_endpoint_not_found' });
  });

  it('rejects Base URLs that could send credentials outside HTTP transports', async () => {
    const fetchMock = vi.fn();

    await expect(
      checkLangfuseConnection(
        testSettings({ baseUrl: 'ftp://langfuse.example.com' }),
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: 'langfuse_base_url_invalid' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops exporter response bodies and redacts authorization values from diagnostics', () => {
    const diagnostic = safeTelemetryDiagnosticValue({
      name: 'OTLPExporterError',
      message: 'Unauthorized prompt echoed: sensitive input',
      code: 401,
      data: '{"prompt":"sensitive input"}',
      headers: { authorization: 'Basic secret' },
    });
    expect(diagnostic).toEqual({
      type: 'Object',
      name: 'OTLPExporterError',
      category: 'authentication',
      code: 401,
    });
    expect(JSON.stringify(diagnostic)).not.toContain('sensitive input');

    const authorizationError = safeTelemetryDiagnosticValue(
      new Error('Authorization: Basic c2VjcmV0'),
    );
    expect(authorizationError).toMatchObject({
      type: 'Error',
      name: 'Error',
      category: 'authentication',
    });
    expect(JSON.stringify(authorizationError)).not.toContain('c2VjcmV0');
  });

  it('recognizes explicit Langfuse diagnostic flags only', () => {
    expect(isLangfuseDiagnosticsEnabled({ LANGFUSE_DIAGNOSTICS: '1' })).toBe(true);
    expect(isLangfuseDiagnosticsEnabled({ LANGFUSE_DIAGNOSTICS: 'TRUE' })).toBe(true);
    expect(isLangfuseDiagnosticsEnabled({ LANGFUSE_DIAGNOSTICS: 'off' })).toBe(false);
    expect(isLangfuseDiagnosticsEnabled({})).toBe(false);
  });

  it('logs span routing without forcing an exporter flush or exposing secrets', async () => {
    const previousDiagnostics = process.env.LANGFUSE_DIAGNOSTICS;
    process.env.LANGFUSE_DIAGNOSTICS = '1';
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const runtime = new ReloadableLangfuseSpanProcessor();
    const processor = fakeProcessor();
    const span = {
      name: 'generate-response',
      attributes: { 'langfuse.trace.metadata.apiKeyId': 'key-1' },
      spanContext: () => ({
        traceId: '11111111111111111111111111111111',
        spanId: '2222222222222222',
      }),
    };

    try {
      runtime.replaceKey('key-1', processor);
      runtime.onStart(span as never, {} as never);
      runtime.onEnd(span as never);

      const logLines = info.mock.calls.map(([line]) => String(line));
      const events = logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            component: 'langfuse',
            event: 'span_queued',
            apiKeyId: 'key-1',
            matchedProcessorCount: 1,
            routed: true,
          }),
        ]),
      );
      expect(processor.forceFlush).not.toHaveBeenCalled();
      expect(logLines.join('\n')).not.toContain('sk-lf-secret');
      expect(logLines.join('\n')).not.toContain('sensitive input');
    } finally {
      await runtime.shutdown();
      info.mockRestore();
      if (previousDiagnostics === undefined) delete process.env.LANGFUSE_DIAGNOSTICS;
      else process.env.LANGFUSE_DIAGNOSTICS = previousDiagnostics;
    }
  });

  it('keeps only the Langfuse origin in Base URL diagnostics', () => {
    expect(
      safeLangfuseBaseUrlForDiagnostics(
        'https://user:password@langfuse.example.test/langfuse/tenant-token?key=secret#fragment',
      ),
    ).toBe('https://langfuse.example.test');
    expect(safeLangfuseBaseUrlForDiagnostics('not a URL')).toBe('<invalid>');
  });

  it('never writes raw processor exceptions to warning logs', async () => {
    const runtime = new ReloadableLangfuseSpanProcessor();
    const processor = fakeProcessor();
    processor.onStart.mockImplementationOnce(() => {
      throw Object.assign(new Error('Unauthorized prompt echoed: sensitive input'), {
        statusCode: 401,
        data: '{"prompt":"sensitive input"}',
      });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    runtime.replaceKey('key-1', processor);
    runtime.onStart({} as never, {} as never);

    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('authentication');
    expect(logged).not.toContain('sensitive input');
    warn.mockRestore();
    await runtime.shutdown();
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
