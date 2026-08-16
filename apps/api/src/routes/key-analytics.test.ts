import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({
  query: vi.fn(async (_sql: string, _params?: unknown[]) => ({
    rows: [] as unknown[],
    rowCount: 0,
  })),
}));

vi.mock('../db/client', () => ({
  getPool: () => ({ query }),
}));

vi.mock('../lib/admin-auth', () => ({
  requireAdmin: async () => undefined,
}));

import { keyAnalyticsRoutes, tokensPerSecond, visibleTokensPerSecond } from './key-analytics';

describe('key analytics metrics', () => {
  it('calculates generation TPS after TTFT', () => {
    expect(tokensPerSecond(120, 2_500, 500)).toBe(60);
  });

  it('returns null when generation duration is unavailable', () => {
    expect(tokensPerSecond(0, 1_000, 200)).toBeNull();
    expect(tokensPerSecond(20, 200, 200)).toBeNull();
    expect(tokensPerSecond(20, 1_000, null)).toBeNull();
  });

  it('calculates visible TPS without reasoning tokens', () => {
    expect(visibleTokensPerSecond(200, 150, 3_000, 2_000)).toBe(50);
    expect(visibleTokensPerSecond(200, null, 3_000, 2_000)).toBeNull();
  });
});

describe('key analytics route', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    query.mockReset();
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    app = Fastify();
    await app.register(keyAnalyticsRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns per-bucket model and provider metrics with the selected range bucket', async () => {
    const keyId = '11111111-1111-4111-8111-111111111111';
    const modelPoint = {
      bucket: '2026-08-10T00:00:00.000Z',
      bucketEnd: '2026-08-10T06:00:00.000Z',
      provider: 'openai',
      model: 'gpt-5',
      calls: 3,
      successfulCalls: 2,
      failedCalls: 1,
      inputTokens: 120,
      outputTokens: 80,
      cachedTokens: 20,
      costUsd: 0.004,
      averageTtftMs: 250,
      averageTps: 40,
      averageLatencyMs: 1_500,
    };
    query
      .mockResolvedValueOnce({
        rows: [
          {
            id: keyId,
            name: 'Production',
            status: 'active',
            langfuseConfigCiphertext: null,
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ calls: 3 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [modelPoint], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/keys/${keyId}/analytics?range=7d&model=%20gpt-5%20&provider=%20openai%20`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().modelSeries).toEqual([modelPoint]);
    const modelSeriesCall = query.mock.calls[3];
    expect(modelSeriesCall?.[0]).toContain('GROUP BY bucket, provider, model');
    expect(modelSeriesCall?.[0]).toContain('u.latency_ms > u.time_to_first_token_ms');
    expect(modelSeriesCall?.[0]).toContain('($3::text IS NULL OR u.model = $3::text)');
    expect(modelSeriesCall?.[0]).toContain(
      "($4::text IS NULL OR COALESCE(p.provider, 'unknown') = $4::text)",
    );
    expect(modelSeriesCall?.[1]).toEqual([keyId, '7 days', 'gpt-5', 'openai', '6 hours']);
    for (const analyticsCall of query.mock.calls.slice(1, 8)) {
      expect(analyticsCall[0]).toContain("COALESCE(p.provider, 'unknown')");
      expect(analyticsCall[1]).toContain('gpt-5');
      expect(analyticsCall[1]).toContain('openai');
    }
    const pricesCall = query.mock.calls[8];
    expect(pricesCall?.[0]).toContain('jsonb_array_elements_text(p.available_models)');
    expect(pricesCall?.[0]).toContain('SELECT p.provider, available.model');
    expect(pricesCall?.[0]).toContain("WHERE p.status = 'active'");
    expect(pricesCall?.[0]).not.toContain('$3::text');
    expect(pricesCall?.[1]).toEqual([keyId]);
  });

  it('applies model and unknown-provider filters to log drilldowns', async () => {
    const keyId = '22222222-2222-4222-8222-222222222222';
    query.mockResolvedValueOnce({ rows: [{ id: keyId }], rowCount: 1 }).mockResolvedValueOnce({
      rows: [{ id: 'log-1', model: 'gpt-5/mini', filteredCount: 2 }],
      rowCount: 1,
    });

    const response = await app.inject({
      method: 'GET',
      url:
        `/api/admin/keys/${keyId}/analytics/logs?range=30d&limit=25&metric=errors` +
        '&model=%20gpt-5%2Fmini%20&provider=%20unknown%20',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      logs: [{ id: 'log-1', model: 'gpt-5/mini' }],
      total: 2,
      query: {
        metric: 'errors',
        threshold: null,
        from: null,
        to: null,
        model: 'gpt-5/mini',
        provider: 'unknown',
      },
    });
    const logsCall = query.mock.calls[1];
    expect(logsCall?.[0]).toContain('LEFT JOIN provider_connections p');
    expect(logsCall?.[0]).toContain('($7::text IS NULL OR u.model = $7::text)');
    expect(logsCall?.[0]).toContain(
      "($8::text IS NULL OR COALESCE(p.provider, 'unknown') = $8::text)",
    );
    expect(logsCall?.[0]).toContain('LIMIT $9');
    expect(logsCall?.[1]).toEqual([
      keyId,
      '30 days',
      null,
      null,
      'errors',
      null,
      'gpt-5/mini',
      'unknown',
      25,
    ]);
  });

  it('rejects overlong model and provider filters before querying the database', async () => {
    const keyId = '33333333-3333-4333-8333-333333333333';

    const analyticsResponse = await app.inject({
      method: 'GET',
      url: `/api/admin/keys/${keyId}/analytics?model=${'m'.repeat(121)}`,
    });
    const logsResponse = await app.inject({
      method: 'GET',
      url: `/api/admin/keys/${keyId}/analytics/logs?provider=${'p'.repeat(41)}`,
    });

    expect(analyticsResponse.statusCode).toBe(400);
    expect(logsResponse.statusCode).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});
