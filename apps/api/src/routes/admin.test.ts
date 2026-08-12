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
