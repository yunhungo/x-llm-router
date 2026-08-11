import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class FakeLangfuseSpanProcessor {
    static instances: FakeLangfuseSpanProcessor[] = [];

    readonly onStart = vi.fn();
    readonly onEnd = vi.fn();
    readonly forceFlush = vi.fn(async () => undefined);
    readonly shutdown = vi.fn(async () => undefined);

    constructor(
      readonly options: {
        publicKey?: string;
        shouldExportSpan?: (input: {
          otelSpan: { attributes: Record<string, unknown> };
        }) => boolean;
      },
    ) {
      if (options.publicKey === 'pk-throw') throw new Error('processor construction failed');
      FakeLangfuseSpanProcessor.instances.push(this);
    }
  }

  class FakeNodeSDK {
    static instances: FakeNodeSDK[] = [];

    readonly start = vi.fn();
    readonly shutdown = vi.fn(async () => {
      await Promise.all(this.options.spanProcessors.map((processor) => processor.shutdown()));
    });

    constructor(
      readonly options: {
        spanProcessors: Array<{ shutdown(): Promise<void> }>;
      },
    ) {
      FakeNodeSDK.instances.push(this);
    }
  }

  return {
    FakeLangfuseSpanProcessor,
    FakeNodeSDK,
    query: vi.fn(),
  };
});

vi.mock('../db/client', () => ({
  getPool: () => ({ query: mocks.query }),
}));

vi.mock('@langfuse/otel', () => ({
  LangfuseSpanProcessor: mocks.FakeLangfuseSpanProcessor,
}));

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: mocks.FakeNodeSDK,
}));

type LangfuseService = typeof import('./langfuse');

const apiKeyId = '11111111-1111-4111-8111-111111111111';

describe('Langfuse runtime reload', () => {
  let service: LangfuseService;

  beforeEach(async () => {
    vi.resetModules();
    mocks.query.mockReset();
    mocks.FakeLangfuseSpanProcessor.instances.length = 0;
    mocks.FakeNodeSDK.instances.length = 0;
    process.env.DATABASE_URL = 'postgresql://example';
    process.env.ENCRYPTION_KEY = 'test-encryption-key-with-enough-length';
    process.env.JWT_SECRET = 'test-jwt-secret-with-enough-length';
    const { resetConfigForTests } = await import('../config');
    resetConfigForTests();
    service = await import('./langfuse');
  });

  afterEach(async () => {
    await service.shutdownLangfuse();
  });

  function settings(overrides: Partial<import('./langfuse').KeyLangfuseSettings> = {}) {
    return {
      ...service.defaultLangfuseSettings(),
      enabled: true,
      publicKey: 'pk-live',
      secretKey: 'sk-live',
      ...overrides,
    };
  }

  it('starts one persistent SDK with zero projects and activates a saved project immediately', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ id: apiKeyId, status: 'active', langfuse_config_ciphertext: null }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(service.initializeLangfuse()).resolves.toBe(0);
    expect(mocks.FakeNodeSDK.instances).toHaveLength(1);
    expect(mocks.FakeNodeSDK.instances[0]?.start).toHaveBeenCalledTimes(1);

    await expect(service.saveApiKeyLangfuseSettings(apiKeyId, settings())).resolves.toBe(true);
    expect(mocks.FakeNodeSDK.instances).toHaveLength(1);
    expect(mocks.FakeLangfuseSpanProcessor.instances).toHaveLength(1);

    const processor = mocks.FakeLangfuseSpanProcessor.instances[0];
    expect(
      processor?.options.shouldExportSpan?.({
        otelSpan: { attributes: { 'langfuse.trace.metadata.apiKeyId': apiKeyId } },
      }),
    ).toBe(true);

    const proxy = mocks.FakeNodeSDK.instances[0]?.options.spanProcessors[0] as unknown as {
      onStart(span: object, context: object): void;
      onEnd(span: object): void;
    };
    const span = {};
    const context = {};
    proxy.onStart(span, context);
    proxy.onEnd(span);
    expect(processor?.onStart).toHaveBeenCalledWith(span, context);
    expect(processor?.onEnd).toHaveBeenCalledWith(span);
  });

  it('disables a configured project without registering another SDK', async () => {
    const initial = settings();
    const ciphertext = service.encryptLangfuseSettings(initial);
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ id: apiKeyId, langfuse_config_ciphertext: ciphertext }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id: apiKeyId, status: 'active', langfuse_config_ciphertext: ciphertext }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await service.initializeLangfuse();
    const previous = mocks.FakeLangfuseSpanProcessor.instances[0];
    await service.saveApiKeyLangfuseSettings(apiKeyId, settings({ enabled: false }));

    const proxy = mocks.FakeNodeSDK.instances[0]?.options.spanProcessors[0] as unknown as {
      forceFlush(): Promise<void>;
    };
    await proxy.forceFlush();
    expect(mocks.FakeNodeSDK.instances).toHaveLength(1);
    expect(mocks.FakeLangfuseSpanProcessor.instances).toHaveLength(1);
    expect(previous?.forceFlush).toHaveBeenCalled();
    expect(previous?.shutdown).toHaveBeenCalled();
  });

  it('keeps the previous processor and stored settings if constructing the replacement fails', async () => {
    const initial = settings();
    const ciphertext = service.encryptLangfuseSettings(initial);
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ id: apiKeyId, langfuse_config_ciphertext: ciphertext }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id: apiKeyId, status: 'active', langfuse_config_ciphertext: ciphertext }],
        rowCount: 1,
      });

    await service.initializeLangfuse();
    const previous = mocks.FakeLangfuseSpanProcessor.instances[0];
    await expect(
      service.saveApiKeyLangfuseSettings(apiKeyId, settings({ publicKey: 'pk-throw' })),
    ).rejects.toThrow('processor construction failed');

    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(previous?.shutdown).not.toHaveBeenCalled();
    expect(mocks.FakeNodeSDK.instances).toHaveLength(1);
  });

  it('cleans up a candidate and retains the previous processor when persistence fails', async () => {
    const initial = settings();
    const ciphertext = service.encryptLangfuseSettings(initial);
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ id: apiKeyId, langfuse_config_ciphertext: ciphertext }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id: apiKeyId, status: 'active', langfuse_config_ciphertext: ciphertext }],
        rowCount: 1,
      })
      .mockRejectedValueOnce(new Error('database unavailable'));

    await service.initializeLangfuse();
    const previous = mocks.FakeLangfuseSpanProcessor.instances[0];
    await expect(
      service.saveApiKeyLangfuseSettings(apiKeyId, settings({ publicKey: 'pk-next' })),
    ).rejects.toThrow('database unavailable');

    const candidate = mocks.FakeLangfuseSpanProcessor.instances[1];
    expect(candidate?.forceFlush).toHaveBeenCalled();
    expect(candidate?.shutdown).toHaveBeenCalled();
    expect(previous?.shutdown).not.toHaveBeenCalled();
  });

  it('does not register a second global provider when initialization is repeated', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await service.initializeLangfuse();
    await service.initializeLangfuse();

    expect(mocks.FakeNodeSDK.instances).toHaveLength(1);
    expect(mocks.FakeNodeSDK.instances[0]?.start).toHaveBeenCalledTimes(1);
  });
});
