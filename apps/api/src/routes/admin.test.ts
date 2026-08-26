import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({
  query: vi.fn(async (_sql: string, _params?: unknown[]) => ({
    rows: [] as unknown[],
    rowCount: 0,
  })),
}));

const { refreshProviderModels } = vi.hoisted(() => ({
  refreshProviderModels: vi.fn(),
}));

vi.mock('../db/client', () => ({
  getPool: () => ({ query }),
}));

vi.mock('../lib/admin-auth', () => ({
  adminId: () => '00000000-0000-4000-8000-000000000000',
  requireAdmin: async () => undefined,
}));

vi.mock('../services/providers', () => ({ refreshProviderModels }));

import { setRuntimeSecretsForTests } from '../runtime-secrets';
import { decryptJson } from '../lib/crypto';
import { encryptLangfuseSettings } from '../services/langfuse';
import { adminRoutes } from './admin';

const keyId = '11111111-1111-4111-8111-111111111111';
const providerId = '22222222-2222-4222-8222-222222222222';

describe('admin API keys', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    query.mockReset();
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    refreshProviderModels.mockReset();
    setRuntimeSecretsForTests({
      ENCRYPTION_KEY: 'test-encryption-key-with-enough-length',
      JWT_SECRET: 'test-jwt-secret-with-enough-length',
    });
    app = Fastify();
    await app.register(adminRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  it('creates an unlimited key when RPM is zero', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/keys',
      payload: { name: 'Unlimited', rpmLimit: 0 },
    });

    expect(response.statusCode).toBe(201);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]?.[5]).toBe(0);
  });

  it('returns the persisted API Key middleware code', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          middlewareCode:
            'async function onRequest(ctx) { return ctx.request; }\nasync function onResponse(ctx) { return ctx.response; }',
          updatedAt: '2026-08-26T00:00:00.000Z',
        },
      ],
      rowCount: 1,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/keys/${keyId}/middleware`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ configured: true });
    expect(response.json().code).toContain('async function onRequest');
  });

  it('validates and saves API Key middleware code', async () => {
    query.mockResolvedValueOnce({
      rows: [{ updatedAt: '2026-08-26T00:00:00.000Z' }],
      rowCount: 1,
    });
    const code = `
      async function onRequest(ctx) { return ctx.request; }
      async function onResponse(ctx) { return ctx.response; }
    `;

    const response = await app.inject({
      method: 'PUT',
      url: `/api/admin/keys/${keyId}/middleware`,
      payload: { code },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, configured: true });
    expect(query.mock.calls[0]?.[0]).toContain('middleware_code = $2');
    expect(query.mock.calls[0]?.[1]).toEqual([keyId, code]);
  });

  it('rejects middleware without both fixed async hooks', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/admin/keys/${keyId}/middleware`,
      payload: { code: 'async function onRequest(ctx) { return ctx.request; }' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_middleware' } });
    expect(query).not.toHaveBeenCalled();
  });

  it('returns persisted provider model discovery state', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: providerId,
          name: 'OpenAI OAuth',
          authType: 'oauth',
          models: ['gpt-5.6-sol'],
          modelsRefreshedAt: '2026-08-12T00:00:00.000Z',
          modelsRefreshError: null,
        },
      ],
      rowCount: 1,
    });

    const response = await app.inject({ method: 'GET', url: '/api/admin/providers' });

    expect(response.statusCode).toBe(200);
    expect(response.json().providers[0]).toMatchObject({
      models: ['gpt-5.6-sol'],
      modelsRefreshedAt: '2026-08-12T00:00:00.000Z',
      modelsRefreshError: null,
    });
    expect(query.mock.calls[0]?.[0]).toContain('available_models AS models');
  });

  it('lists only persisted model price records', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          provider: 'openai',
          modelPattern: 'gpt-5.6-sol',
          inputPerMillion: 5,
          cachedInputPerMillion: 0.5,
          outputPerMillion: 30,
          updatedAt: '2026-08-26T00:00:00.000Z',
        },
      ],
      rowCount: 1,
    });

    const response = await app.inject({ method: 'GET', url: '/api/admin/settings/model-prices' });

    expect(response.statusCode).toBe(200);
    expect(response.json().prices).toHaveLength(1);
    expect(response.json().prices[0]).toMatchObject({
      provider: 'openai',
      modelPattern: 'gpt-5.6-sol',
    });
    expect(query.mock.calls[0]?.[0]).toContain('FROM model_prices');
  });

  it('upserts one model price record', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/admin/settings/model-prices',
      payload: {
        provider: 'openai',
        modelPattern: 'gpt-5.6-sol',
        inputPerMillion: 5,
        cachedInputPerMillion: 0.5,
        outputPerMillion: 30,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(query.mock.calls[0]?.[0]).toContain('ON CONFLICT (provider, model_pattern)');
    expect(query.mock.calls[0]?.[1]).toEqual(['openai', 'gpt-5.6-sol', 5, 0.5, 30]);
  });

  it('deletes one exact model price record', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/admin/settings/model-prices',
      payload: { provider: 'openai', modelPattern: 'gpt-5.6-sol' },
    });

    expect(response.statusCode).toBe(200);
    expect(query.mock.calls[0]?.[0]).toContain('DELETE FROM model_prices');
    expect(query.mock.calls[0]?.[1]).toEqual(['openai', 'gpt-5.6-sol']);
  });

  it('reports a missing model price record when deleting', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/admin/settings/model-prices',
      payload: { provider: '*', modelPattern: 'missing-model' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'price_not_found' } });
  });

  it('refreshes models for a valid provider connection', async () => {
    refreshProviderModels.mockResolvedValueOnce({
      models: ['gpt-5.6-sol', 'gpt-5.6-terra'],
      refreshedAt: '2026-08-12T00:00:00.000Z',
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/providers/${providerId}/models/refresh`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ models: ['gpt-5.6-sol', 'gpt-5.6-terra'] });
    expect(refreshProviderModels).toHaveBeenCalledWith(providerId);
  });

  it('rejects an invalid provider ID before model refresh', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/providers/not-a-uuid/models/refresh',
    });

    expect(response.statusCode).toBe(400);
    expect(refreshProviderModels).not.toHaveBeenCalled();
  });

  it('updates API Key connection settings and encrypts a replacement credential', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ auth_type: 'api_key' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: providerId }], rowCount: 1 });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/admin/providers/${providerId}`,
      payload: {
        name: '  DeepSeek  ',
        apiMode: 'responses',
        apiKey: 'sk-replacement-key',
        baseUrl: 'https://api.deepseek.com/v1',
        defaultModel: 'deepseek-chat',
        priority: 20,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(query).toHaveBeenCalledTimes(2);
    const params = query.mock.calls[1]?.[1] as unknown[];
    expect(params.slice(0, 10)).toEqual([
      providerId,
      true,
      'DeepSeek',
      false,
      null,
      true,
      'responses',
      true,
      'https://api.deepseek.com/v1',
      true,
    ]);
    expect(decryptJson<{ apiKey: string }>(String(params[10]))).toEqual({
      apiKey: 'sk-replacement-key',
    });
    expect(params.slice(11)).toEqual([true, 'deepseek-chat', true, 20]);
  });

  it('allows common routing fields on an OAuth connection', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ auth_type: 'oauth' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: providerId }], rowCount: 1 });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/admin/providers/${providerId}`,
      payload: { name: 'ChatGPT OAuth', defaultModel: null, priority: 5 },
    });

    expect(response.statusCode).toBe(200);
    expect(query.mock.calls[1]?.[1]).toEqual([
      providerId,
      true,
      'ChatGPT OAuth',
      false,
      null,
      false,
      null,
      false,
      null,
      false,
      null,
      true,
      null,
      true,
      5,
    ]);
  });

  it('rejects API Key-only fields on an OAuth connection', async () => {
    query.mockResolvedValueOnce({ rows: [{ auth_type: 'oauth' }], rowCount: 1 });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/admin/providers/${providerId}`,
      payload: { baseUrl: 'https://api.example.com/v1' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'provider_auth_type_mismatch' },
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty provider update before querying the database', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/admin/providers/${providerId}`,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a negative RPM when creating a key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/keys',
      payload: { name: 'Invalid', rpmLimit: -1 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(query).not.toHaveBeenCalled();
  });

  it('updates every supported field and validates a selected provider', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: providerId }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: keyId }], rowCount: 1 });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/admin/keys/${keyId}`,
      payload: {
        name: '  Production  ',
        rpmLimit: 0,
        budgetUsd: 25.5,
        expiresAt: '2027-01-02T03:04:05.000Z',
        providerConnectionId: providerId,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[1]).toEqual([providerId]);
    expect(query.mock.calls[1]?.[1]).toEqual([
      keyId,
      true,
      'Production',
      true,
      0,
      true,
      25.5,
      true,
      '2027-01-02T03:04:05.000Z',
      true,
      providerId,
    ]);
  });

  it('preserves omitted fields while allowing explicit nullable values', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: keyId }], rowCount: 1 });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/admin/keys/${keyId}`,
      payload: {
        budgetUsd: null,
        expiresAt: null,
        providerConnectionId: null,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([
      keyId,
      false,
      null,
      false,
      null,
      true,
      null,
      true,
      null,
      true,
      null,
    ]);
  });

  it.each([
    [{}, 'empty body'],
    [{ unrelated: true }, 'no supported field'],
    [{ name: '   ' }, 'empty name'],
    [{ rpmLimit: -1 }, 'negative RPM'],
    [{ rpmLimit: 100_001 }, 'RPM above the maximum'],
    [{ budgetUsd: -1 }, 'negative budget'],
    [{ expiresAt: 'tomorrow' }, 'invalid expiry'],
    [{ providerConnectionId: 'not-a-uuid' }, 'invalid provider ID'],
  ])('rejects %s (%s)', async (payload, _label) => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/admin/keys/${keyId}`,
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps the provider-not-found error for a non-null provider selection', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/admin/keys/${keyId}`,
      payload: { providerConnectionId: providerId },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'provider_not_found' } });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('tests the current Langfuse draft with the previously stored secret key', async () => {
    const ciphertext = encryptLangfuseSettings({
      enabled: true,
      publicKey: 'pk-lf-stored',
      secretKey: 'sk-lf-stored',
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
    });
    query.mockResolvedValueOnce({
      rows: [{ id: keyId, langfuse_config_ciphertext: ciphertext }],
      rowCount: 1,
    });
    const fetchMock = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response('{"data":[]}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/keys/${keyId}/langfuse/test`,
      payload: {
        enabled: true,
        publicKey: 'pk-lf-current',
        baseUrl: 'https://us.cloud.langfuse.com',
        environment: 'production',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      baseUrl: 'https://us.cloud.langfuse.com',
      statusCode: 200,
    });
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get('authorization')).toBe(
      `Basic ${Buffer.from('pk-lf-current:sk-lf-stored').toString('base64')}`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'https://us.cloud.langfuse.com/api/public/otel/v1/traces',
    );
    expect(response.body).not.toContain('sk-lf-stored');
  });
});
