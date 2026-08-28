import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setRuntimeSecretsForTests } from '../runtime-secrets';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../db/client', () => ({
  getPool: () => ({ query }),
}));

vi.mock('../lib/admin-auth', () => ({
  requireAdmin: async () => undefined,
}));

import { encryptJson } from '../lib/crypto';
import { usageDetailRoutes } from './usage-details';

const usageLogId = '11111111-1111-4111-8111-111111111111';
const rawKey = 'xr_test-secret';

function detailRow() {
  return {
    id: usageLogId,
    requestId: 'request-123',
    endpoint: 'chat.completions',
    requestedModel: 'gpt-test',
    upstreamModel: 'gpt-upstream',
    createdAt: '2026-08-28T00:00:00.000Z',
    gatewayCurl: 'curl placeholder',
    upstreamCurl: null,
    clientRequest: {
      method: 'POST',
      url: 'https://router.test/v1/chat/completions',
      headers: { authorization: '[REDACTED]' },
      body: { model: 'gpt-test' },
    },
    upstreamRequest: null,
    upstreamResponse: null,
    error: null,
    capturedAt: '2026-08-28T00:00:00.000Z',
    expiresAt: '2026-09-27T00:00:00.000Z',
    routerApiTokenCiphertext: encryptJson(rawKey),
  };
}

describe('usage detail credentials', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    setRuntimeSecretsForTests({
      ENCRYPTION_KEY: 'test-encryption-key-with-enough-length',
      JWT_SECRET: 'test-jwt-secret-with-enough-length',
    });
    query.mockReset();
    query.mockResolvedValue({ rows: [detailRow()], rowCount: 1 });
    app = Fastify();
    await app.register(usageDetailRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('keeps the default detail CURL redacted', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/usage/logs/${usageLogId}/detail`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().detail.gatewayCurl).toContain('Bearer <ROUTER_API_KEY>');
    expect(response.body).not.toContain(rawKey);
  });

  it('decrypts the key only for the explicit preserve-key endpoint', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/usage/logs/${usageLogId}/detail/curl-with-key`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().curl).toContain(`Authorization: Bearer ${rawKey}`);
    expect(response.json().curl).not.toContain('<ROUTER_API_KEY>');
  });

  it('reports that older details do not have a preserved key', async () => {
    query.mockResolvedValueOnce({
      rows: [{ ...detailRow(), routerApiTokenCiphertext: null }],
      rowCount: 1,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/usage/logs/${usageLogId}/detail/curl-with-key`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'credential_unavailable' } });
  });
});
