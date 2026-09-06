/**
 * @created 2026-09-06
 * @description 验证网关转换上游响应后使用与正文一致的媒体类型。
 * @author yunhungo
 */
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { gatewayRoutes } from './gateway';

const fixture = vi.hoisted(() => ({
  middleware: true,
  headerName: 'content-type',
  contentType: 'text/event-stream; charset=utf-8',
  failure: false,
  stream: false,
  body: { id: 'fixture-response', choices: [{ message: { content: 'ok' } }] },
}));

vi.mock('@langfuse/tracing', () => ({
  propagateAttributes: (_attributes: unknown, run: () => unknown) => run(),
  startObservation: () => ({ update: vi.fn(), end: vi.fn() }),
}));
vi.mock('../services/usage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/usage')>()),
  beginUsage: vi.fn(),
  updateUsageCallStatus: vi.fn().mockResolvedValue(undefined),
  recordUsage: vi.fn().mockResolvedValue({ costUsd: 0 }),
}));
vi.mock('../services/virtual-keys', () => ({
  requireVirtualApiKey: async (request: object) => {
    Object.assign(request, {
      routerKey: {
        id: 'fixture-key',
        name: 'Synthetic fixture',
        providerConnectionId: 'fixture-provider',
        middlewareCode: fixture.middleware ? 'fixture middleware' : '',
      },
    });
  },
}));
vi.mock('../services/providers', () => ({
  getProviderRuntime: async () => ({
    id: 'fixture-provider',
    name: 'Fixture',
    provider: 'openai',
    authType: 'api_key',
    apiMode: 'chat.completions',
    baseUrl: 'https://example.invalid/v1',
    defaultModel: 'fixture-model',
    authorization: 'Bearer fixture',
    headers: {},
  }),
}));
vi.mock('../services/key-middleware', () => ({
  createKeyMiddlewareSession: async () => ({
    onRequest: async (input: unknown) => input,
    onResponse: async (input: unknown) => input,
    dispose: async () => {},
  }),
}));
vi.mock('../providers/pi-ai', () => ({
  preparePiRequest: () => ({
    model: { id: 'fixture-model' },
    clientWantsStream: fixture.stream,
    includeUsageInStream: false,
    capture: {
      response: {
        status: fixture.failure ? 429 : 200,
        headers: { [fixture.headerName]: fixture.contentType, 'x-fixture': 'preserved' },
      },
    },
    events: (async function* () {
      yield fixture.failure
        ? { type: 'error', reason: 'error', error: { usage: {} } }
        : { type: 'done', message: { usage: {} } };
    })(),
  }),
  tokenUsageFromPi: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
  piReportedCost: () => undefined,
  piErrorMessage: () => 'Synthetic upstream failure',
}));
vi.mock('../providers/pi-openai', () => ({
  finalOpenAiResponse: () => fixture.body,
  PiOpenAiStreamSerializer: class {
    feed() {
      return [new TextEncoder().encode('data: [DONE]\n\n')];
    }
  },
}));

let app: ReturnType<typeof Fastify>;
beforeEach(async () => {
  Object.assign(fixture, {
    middleware: true,
    headerName: 'content-type',
    contentType: 'text/event-stream; charset=utf-8',
    failure: false,
    stream: false,
  });
  app = Fastify();
  await app.register(gatewayRoutes);
});
afterEach(async () => app.close());

describe.each(['/v1/chat/completions', '/v1/responses'])('%s response media type', (url) => {
  it.each([
    { middleware: true, headerName: 'content-type', contentType: 'text/event-stream' },
    { middleware: true, headerName: 'Content-Type', contentType: 'text/event-stream' },
    { middleware: false, headerName: 'content-type', contentType: 'text/event-stream' },
    { middleware: true, headerName: 'content-type', contentType: 'application/json' },
  ])(
    'sends aggregated JSON with $middleware middleware and $headerName: $contentType',
    async (scenario) => {
      Object.assign(fixture, scenario);
      const response = await app.inject({
        method: 'POST',
        url,
        payload: { model: 'fixture-model', stream: false },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.json()).toEqual(fixture.body);
      if (fixture.middleware) expect(response.headers['x-fixture']).toBe('preserved');
    },
  );

  it('preserves upstream error status and serializes its JSON error body', async () => {
    fixture.failure = true;
    const response = await app.inject({
      method: 'POST',
      url,
      payload: { model: 'fixture-model', stream: false },
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toMatchObject({ error: { code: 'upstream_error' } });
  });

  it('retains event-stream headers for an explicitly streaming client', async () => {
    fixture.stream = true;
    const response = await app.inject({
      method: 'POST',
      url,
      payload: { model: 'fixture-model', stream: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toBe('data: [DONE]\n\n');
  });
});
