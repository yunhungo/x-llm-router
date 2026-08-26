import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setRuntimeSecretsForTests } from '../runtime-secrets';

const { query } = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('../db/client', () => ({
  getPool: () => ({ query }),
}));

import { requireVirtualApiKey } from './virtual-keys';

function virtualKeyRow(rpmLimit: number) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Development',
    key_prefix: 'xr_test',
    budget_usd: null,
    spend_usd: '0',
    rpm_limit: rpmLimit,
    provider_connection_id: null,
    middleware_code: null,
    langfuse_config_ciphertext: null,
  };
}

function requestWithKey(): FastifyRequest {
  return {
    headers: { authorization: 'Bearer xr_test-secret' },
  } as FastifyRequest;
}

function replyMock(): FastifyReply {
  const reply = {
    header: vi.fn(),
    code: vi.fn(),
    send: vi.fn(async () => undefined),
  };
  reply.header.mockReturnValue(reply);
  reply.code.mockReturnValue(reply);
  return reply as unknown as FastifyReply;
}

describe('virtual API key RPM limits', () => {
  beforeEach(() => {
    query.mockReset();
    setRuntimeSecretsForTests({
      ENCRYPTION_KEY: 'test-encryption-key-with-enough-length',
      JWT_SECRET: 'test-jwt-secret-with-enough-length',
    });
  });

  it('skips the rate-limit query when RPM is zero', async () => {
    query.mockResolvedValueOnce({ rows: [virtualKeyRow(0)], rowCount: 1 });
    const request = requestWithKey();
    const reply = replyMock();

    await requireVirtualApiKey(request, reply);

    expect(query).toHaveBeenCalledTimes(1);
    expect(reply.code).not.toHaveBeenCalled();
    expect(request.routerKey).toMatchObject({ rpmLimit: 0 });
    expect(query.mock.calls[0]?.[0]).toContain('middleware_code');
  });

  it('still rejects a limited key after it reaches its RPM limit', async () => {
    query
      .mockResolvedValueOnce({ rows: [virtualKeyRow(2)], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: '2' }], rowCount: 1 });
    const request = requestWithKey();
    const reply = replyMock();

    await requireVirtualApiKey(request, reply);

    expect(query).toHaveBeenCalledTimes(2);
    expect(reply.header).toHaveBeenCalledWith('retry-after', '60');
    expect(reply.code).toHaveBeenCalledWith(429);
    expect(reply.send).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: 'rpm_limit_exceeded' }),
    });
    expect(request.routerKey).toBeUndefined();
  });
});
