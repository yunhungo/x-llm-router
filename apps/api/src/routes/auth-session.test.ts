import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('../db/client', () => ({
  getPool: () => ({ query }),
}));

import { buildApp } from '../app';
import { resetConfigForTests } from '../config';
import { setRuntimeSecretsForTests } from '../runtime-secrets';

describe('admin session cookie', () => {
  let app: FastifyInstance;
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

    const passwordHash = await bcrypt.hash('change-me-now', 4);
    query.mockReset();
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM platform_users WHERE username')) {
        return {
          rows: [
            {
              id: '00000000-0000-4000-8000-000000000000',
              username: 'admin',
              password_hash: passwordHash,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    app = await buildApp();
    await app.ready();
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

  it('keeps a session across requests when production is served over HTTP', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: 'router.example.test' },
      payload: { username: 'admin', password: 'change-me-now' },
    });

    expect(login.statusCode).toBe(200);
    const setCookie = login.headers['set-cookie'];
    expect(setCookie).toBeTypeOf('string');
    expect(setCookie).not.toContain('Secure');

    const sessionCookie = (setCookie as string).split(';', 1)[0];
    const currentUser = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: sessionCookie },
    });

    expect(currentUser.statusCode).toBe(200);
    expect(currentUser.json()).toEqual({
      user: { id: '00000000-0000-4000-8000-000000000000', username: 'admin' },
    });
  });

  it('keeps Secure on sessions received through an HTTPS reverse proxy', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: {
        host: 'router.example.test',
        'x-forwarded-proto': 'https',
      },
      payload: { username: 'admin', password: 'change-me-now' },
    });

    expect(login.statusCode).toBe(200);
    expect(login.headers['set-cookie']).toContain('Secure');
  });
});
