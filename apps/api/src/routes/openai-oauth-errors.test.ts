import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { query, startDeviceFlow } = vi.hoisted(() => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  startDeviceFlow: vi.fn(),
}));

vi.mock('../db/client', () => ({
  getPool: () => ({ query }),
}));

vi.mock('../services/openai-oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/openai-oauth')>()),
  startDeviceFlow,
}));

import { buildApp } from '../app';
import { resetConfigForTests } from '../config';
import { setRuntimeSecretsForTests } from '../runtime-secrets';

describe('OpenAI OAuth error responses', () => {
  let app: FastifyInstance;
  let sessionCookie: string;
  const originalEnvironment = {
    DATABASE_URL: process.env.DATABASE_URL,
    LOG_LEVEL: process.env.LOG_LEVEL,
    NODE_ENV: process.env.NODE_ENV,
    WEB_ORIGIN: process.env.WEB_ORIGIN,
    WEB_ROOT: process.env.WEB_ROOT,
  };

  beforeEach(async () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://example';
    process.env.LOG_LEVEL = 'silent';
    delete process.env.WEB_ORIGIN;
    delete process.env.WEB_ROOT;
    resetConfigForTests();
    setRuntimeSecretsForTests({
      ENCRYPTION_KEY: 'test-encryption-key-with-enough-length',
      JWT_SECRET: 'test-jwt-secret-with-enough-length',
    });
    query.mockClear();
    startDeviceFlow.mockReset();

    app = await buildApp();
    await app.ready();
    sessionCookie = `xrouter_session=${app.jwt.sign({
      sub: '00000000-0000-4000-8000-000000000000',
      username: 'admin',
    })}`;
  });

  afterEach(async () => {
    await app.close();
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetConfigForTests();
    setRuntimeSecretsForTests();
  });

  it('exposes the allowlisted OAuth 502 message in the API envelope', async () => {
    startDeviceFlow.mockRejectedValueOnce(
      Object.assign(new Error('无法连接 OpenAI OAuth 服务。'), {
        statusCode: 502,
        code: 'openai_oauth_unavailable',
        exposeMessage: true,
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/providers/oauth/start',
      headers: { cookie: sessionCookie },
      payload: { name: 'OpenAI OAuth' },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: {
        type: 'api_error',
        code: 'openai_oauth_unavailable',
        message: '无法连接 OpenAI OAuth 服务。',
      },
    });
  });

  it('does not expose an unexpected plugin error in production', async () => {
    startDeviceFlow.mockRejectedValueOnce(new Error('database password accidentally surfaced'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/providers/oauth/start',
      headers: { cookie: sessionCookie },
      payload: { name: 'OpenAI OAuth' },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        type: 'api_error',
        code: 'internal_error',
        message: 'Internal server error.',
      },
    });
  });
});
