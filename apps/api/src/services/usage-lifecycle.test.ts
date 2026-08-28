import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setRuntimeSecretsForTests } from '../runtime-secrets';

const { poolQuery, clientQuery, connect, release } = vi.hoisted(() => {
  const poolQuery = vi.fn();
  const clientQuery = vi.fn();
  const release = vi.fn();
  return {
    poolQuery,
    clientQuery,
    release,
    connect: vi.fn(async () => ({ query: clientQuery, release })),
  };
});

vi.mock('../db/client', () => ({
  getPool: () => ({ query: poolQuery, connect }),
}));

import { beginUsage, emptyUsage, recordUsage, updateUsageCallStatus } from './usage';
import { decryptJson } from '../lib/crypto';

describe('usage call lifecycle', () => {
  beforeEach(() => {
    poolQuery.mockReset();
    clientQuery.mockReset();
    connect.mockClear();
    release.mockReset();
    poolQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    setRuntimeSecretsForTests({
      ENCRYPTION_KEY: 'test-encryption-key-with-enough-length',
      JWT_SECRET: 'test-jwt-secret-with-enough-length',
    });
  });

  it('creates a processing record before the request completes', async () => {
    await beginUsage({
      requestId: 'request-1',
      virtualApiKeyId: 'key-1',
      endpoint: 'responses',
      requestedModel: 'gpt-test',
    });

    expect(poolQuery).toHaveBeenCalledOnce();
    expect(poolQuery.mock.calls[0]?.[0]).toContain("'processing',NULL,NULL");
    expect(poolQuery.mock.calls[0]?.[1]).toEqual([
      expect.any(String),
      'request-1',
      'key-1',
      'responses',
      'gpt-test',
      'gpt-test',
    ]);
  });

  it('only advances active records through monotonic intermediate states', async () => {
    await updateUsageCallStatus('request-1', 'thinking');
    await updateUsageCallStatus('request-1', 'responding');

    expect(poolQuery.mock.calls[0]?.[0]).toContain("call_status = 'processing'");
    expect(poolQuery.mock.calls[0]?.[1]).toEqual(['request-1', 'thinking']);
    expect(poolQuery.mock.calls[1]?.[0]).toContain("call_status IN ('processing', 'thinking')");
    expect(poolQuery.mock.calls[1]?.[1]).toEqual(['request-1', 'responding']);
  });

  it('finalizes the existing record and attaches details to its persisted id', async () => {
    clientQuery.mockImplementation(async (sql: string) =>
      sql.includes('RETURNING id')
        ? { rows: [{ id: 'persisted-log-id' }], rowCount: 1 }
        : { rows: [], rowCount: 1 },
    );

    await recordUsage({
      requestId: 'request-1',
      virtualApiKeyId: 'key-1',
      endpoint: 'responses',
      requestedModel: 'gpt-test',
      model: 'gpt-test-actual',
      statusCode: 200,
      usage: emptyUsage(),
      latencyMs: 125,
      reportedCostUsd: 0,
      details: {
        gatewayCurl: 'curl gateway',
        routerApiToken: 'xr_test-secret',
        clientRequest: { body: { model: 'gpt-test' } },
      },
    });

    const finalWrite = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('ON CONFLICT (request_id) DO UPDATE SET'),
    );
    expect(finalWrite?.[1]?.[7]).toBe('completed');
    const detailWrite = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO usage_log_details'),
    );
    expect(detailWrite?.[1]?.[0]).toBe('persisted-log-id');
    expect(decryptJson(detailWrite?.[1]?.[2] as string)).toBe('xr_test-secret');
    expect(clientQuery).toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('does not charge a terminal record again when finalization is retried', async () => {
    clientQuery.mockImplementation(async (sql: string) =>
      sql.includes('RETURNING id') ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 1 },
    );

    await recordUsage({
      requestId: 'request-1',
      virtualApiKeyId: 'key-1',
      endpoint: 'responses',
      requestedModel: 'gpt-test',
      model: 'gpt-test',
      statusCode: 200,
      usage: emptyUsage(),
      latencyMs: 125,
      reportedCostUsd: 0.25,
    });

    expect(
      clientQuery.mock.calls.some(([sql]) => String(sql).includes('spend_usd = spend_usd +')),
    ).toBe(false);
    expect(clientQuery).toHaveBeenCalledWith('COMMIT');
  });
});
