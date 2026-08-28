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

import { adminUsageRoutes } from './admin-usage.routes';

function logRow(id: string, createdAt: string) {
  return {
    id,
    requestId: `request-${id}`,
    createdAt,
    cursorCreatedAt: createdAt,
  };
}

describe('admin usage log pagination', () => {
  const from = '2026-08-21T12:00:00.000Z';
  const to = '2026-08-28T12:00:00.000Z';
  let app: FastifyInstance;

  beforeEach(async () => {
    query.mockReset();
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    app = Fastify();
    await app.register(adminUsageRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns one bounded page and an opaque cursor when older logs exist', async () => {
    const firstId = '33333333-3333-4333-8333-333333333333';
    const secondId = '22222222-2222-4222-8222-222222222222';
    query.mockResolvedValueOnce({
      rows: [
        logRow(firstId, '2026-08-28T12:00:02.123456Z'),
        logRow(secondId, '2026-08-28T12:00:01.123456Z'),
        logRow('11111111-1111-4111-8111-111111111111', '2026-08-28T12:00:00.123456Z'),
      ],
      rowCount: 3,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/usage/logs?limit=2&from=${from}&to=${to}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      logs: [{ id: firstId }, { id: secondId }],
      hasMore: true,
      nextCursor: expect.any(String),
    });
    expect(response.body).not.toContain('cursorCreatedAt');
    expect(query.mock.calls[0]?.[0]).toContain('ORDER BY f.created_at DESC, f.id DESC');
    expect(query.mock.calls[0]?.[0]).toContain('LIMIT $13');
    expect(query.mock.calls[0]?.[1]).toEqual([
      from,
      to,
      null,
      null,
      null,
      'all',
      null,
      null,
      null,
      null,
      'recent',
      null,
      3,
    ]);
    expect(query.mock.calls[1]?.[0]).toContain('array_agg(DISTINCT u.model');
  });

  it('uses the preceding page boundary for the next query', async () => {
    const boundaryId = '22222222-2222-4222-8222-222222222222';
    const boundaryCreatedAt = '2026-08-28T12:00:01.123456Z';
    query.mockResolvedValueOnce({
      rows: [
        logRow('33333333-3333-4333-8333-333333333333', '2026-08-28T12:00:02.123456Z'),
        logRow(boundaryId, boundaryCreatedAt),
        logRow('11111111-1111-4111-8111-111111111111', '2026-08-28T12:00:00.123456Z'),
      ],
      rowCount: 3,
    });
    const firstResponse = await app.inject({
      method: 'GET',
      url: `/api/admin/usage/logs?limit=2&from=${from}&to=${to}`,
    });
    const cursor = firstResponse.json().nextCursor as string;
    query.mockResolvedValueOnce({
      rows: [logRow('11111111-1111-4111-8111-111111111111', '2026-08-28T12:00:00.123456Z')],
      rowCount: 1,
    });

    const response = await app.inject({
      method: 'GET',
      url:
        `/api/admin/usage/logs?limit=2&from=${from}&to=${to}` +
        `&cursor=${encodeURIComponent(cursor)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ hasMore: false, nextCursor: null });
    expect(query.mock.calls[2]?.[1]).toEqual([
      from,
      to,
      boundaryCreatedAt,
      boundaryId,
      null,
      'all',
      null,
      null,
      null,
      null,
      'recent',
      null,
      3,
    ]);
    expect(query.mock.calls[2]?.[0]).toContain('u.created_at = $3::timestamptz');
    expect(query.mock.calls[2]?.[0]).toContain('u.id < $4::uuid');
  });

  it('applies time, key, search, status, model, and endpoint filters on the server', async () => {
    const keyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    const response = await app.inject({
      method: 'GET',
      url:
        `/api/admin/usage/logs?from=${from}&to=${to}&keyId=${keyId}` +
        '&search=request-42&status=failed&model=gpt-5&endpoint=responses',
    });

    expect(response.statusCode).toBe(200);
    expect(query.mock.calls[0]?.[0]).toContain("u.request_id ILIKE '%' || $5::text || '%'");
    expect(query.mock.calls[0]?.[0]).toContain("$6::text = 'failed'");
    expect(query.mock.calls[0]?.[0]).toContain('u.virtual_api_key_id = $9::uuid');
    expect(query.mock.calls[0]?.[1]).toEqual([
      from,
      to,
      null,
      null,
      'request-42',
      'failed',
      'gpt-5',
      'responses',
      keyId,
      null,
      'recent',
      null,
      51,
    ]);
  });

  it('rejects malformed cursors before querying the database', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/usage/logs?cursor=not-a-cursor',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_cursor' } });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects reversed time windows before querying the database', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/usage/logs?from=${to}&to=${from}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_time_range' } });
    expect(query).not.toHaveBeenCalled();
  });
});
