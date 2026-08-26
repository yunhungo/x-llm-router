import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({
  query: vi.fn(async (_sql: string, _params?: unknown[]) => ({
    rows: [] as unknown[],
    rowCount: 0,
  })),
}));

vi.mock('../../db/client', () => ({
  getPool: () => ({ query }),
}));

vi.mock('../../lib/admin-auth', () => ({
  requireAdmin: async () => undefined,
}));

import { modelPricingRoutes } from './model-pricing.routes';

describe('model pricing routes', () => {
  const keyId = '11111111-1111-4111-8111-111111111111';
  let app: FastifyInstance;

  beforeEach(async () => {
    query.mockReset();
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    app = Fastify();
    await app.register(modelPricingRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('lists only persisted model price records', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: keyId }], rowCount: 1 }).mockResolvedValueOnce({
      rows: [
        {
          provider: 'openai',
          modelPattern: 'gpt-5.6-sol',
          inputPerMillion: 5,
          cachedInputPerMillion: 0.5,
          outputPerMillion: 30,
          updatedAt: new Date('2026-08-26T00:00:00.000Z'),
        },
      ],
      rowCount: 1,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/keys/${keyId}/model-prices`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().prices).toEqual([
      expect.objectContaining({
        provider: 'openai',
        modelPattern: 'gpt-5.6-sol',
        updatedAt: '2026-08-26T00:00:00.000Z',
      }),
    ]);
    expect(query.mock.calls[1]?.[0]).toContain('WHERE virtual_api_key_id = $1');
    expect(query.mock.calls[1]?.[1]).toEqual([keyId]);
  });

  it('upserts one model price record', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: keyId }], rowCount: 1 });
    const response = await app.inject({
      method: 'PUT',
      url: `/api/admin/keys/${keyId}/model-prices`,
      payload: {
        provider: 'openai',
        modelPattern: 'gpt-5.6-sol',
        inputPerMillion: 5,
        cachedInputPerMillion: 0.5,
        outputPerMillion: 30,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(query.mock.calls[1]?.[0]).toContain(
      'ON CONFLICT (virtual_api_key_id, provider, model_pattern)',
    );
    expect(query.mock.calls[1]?.[1]).toEqual([keyId, 'openai', 'gpt-5.6-sol', 5, 0.5, 30]);
  });

  it('deletes one exact model price record', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: keyId }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/admin/keys/${keyId}/model-prices`,
      payload: { provider: 'openai', modelPattern: 'gpt-5.6-sol' },
    });

    expect(response.statusCode).toBe(200);
    expect(query.mock.calls[1]?.[0]).toContain('DELETE FROM model_prices');
    expect(query.mock.calls[1]?.[1]).toEqual([keyId, 'openai', 'gpt-5.6-sol']);
  });

  it('reports a missing model price record when deleting', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: keyId }], rowCount: 1 });
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/admin/keys/${keyId}/model-prices`,
      payload: { provider: '*', modelPattern: 'missing-model' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'price_not_found' } });
  });

  it('reports a missing API Key before reading prices', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/keys/${keyId}/model-prices`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'key_not_found' } });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
