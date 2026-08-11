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

import { keyAnalyticsRoutes, tokensPerSecond } from './key-analytics';

describe('key analytics metrics', () => {
  it('calculates generation TPS after TTFT', () => {
    expect(tokensPerSecond(120, 2_500, 500)).toBe(60);
  });

  it('returns null when generation duration is unavailable', () => {
    expect(tokensPerSecond(0, 1_000, 200)).toBeNull();
    expect(tokensPerSecond(20, 200, 200)).toBeNull();
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
      url: `/api/admin/keys/${keyId}/analytics?range=7d`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().modelSeries).toEqual([modelPoint]);
    const modelSeriesCall = query.mock.calls[3];
    expect(modelSeriesCall?.[0]).toContain('GROUP BY bucket, provider, model');
    expect(modelSeriesCall?.[0]).toContain('u.latency_ms > COALESCE(u.time_to_first_token_ms, 0)');
    expect(modelSeriesCall?.[1]).toEqual([keyId, '7 days', '6 hours']);
  });
});
