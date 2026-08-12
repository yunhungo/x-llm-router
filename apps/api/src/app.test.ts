import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
}));

vi.mock('./db/client', () => ({
  getPool: () => ({ query }),
}));

import { buildApp } from './app';
import { resetConfigForTests } from './config';
import { setRuntimeSecretsForTests } from './runtime-secrets';

describe('embedded web application', () => {
  let app: FastifyInstance;
  let webRoot: string;
  const originalEnvironment = {
    BUILD_SHA: process.env.BUILD_SHA,
    DATABASE_URL: process.env.DATABASE_URL,
    LOG_LEVEL: process.env.LOG_LEVEL,
    WEB_ROOT: process.env.WEB_ROOT,
    WEB_ORIGIN: process.env.WEB_ORIGIN,
  };

  beforeAll(async () => {
    webRoot = await mkdtemp(join(tmpdir(), 'x-router-web-'));
    await mkdir(join(webRoot, 'assets'));
    await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>xRouter</title>');
    await writeFile(join(webRoot, 'assets', 'app.js'), 'globalThis.xRouter = true;');

    process.env.DATABASE_URL = 'postgresql://example';
    process.env.BUILD_SHA = 'test-build-sha';
    process.env.LOG_LEVEL = 'silent';
    process.env.WEB_ROOT = webRoot;
    delete process.env.WEB_ORIGIN;
    resetConfigForTests();
    setRuntimeSecretsForTests({
      ENCRYPTION_KEY: 'test-encryption-key-with-enough-length',
      JWT_SECRET: 'test-jwt-secret-with-enough-length',
    });

    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await rm(webRoot, { recursive: true, force: true });
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetConfigForTests();
    setRuntimeSecretsForTests();
  });

  it('serves the built index and static assets', async () => {
    const indexResponse = await app.inject({
      method: 'GET',
      url: '/',
      headers: { accept: 'text/html' },
    });
    expect(indexResponse.statusCode).toBe(200);
    expect(indexResponse.body).toContain('<title>xRouter</title>');

    const assetResponse = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(assetResponse.statusCode).toBe(200);
    expect(assetResponse.body).toContain('globalThis.xRouter');
  });

  it('exposes the running build revision on health endpoints', async () => {
    const healthResponse = await app.inject({ method: 'GET', url: '/healthz' });
    expect(healthResponse.statusCode).toBe(200);
    expect(healthResponse.json()).toEqual({ status: 'ok', buildSha: 'test-build-sha' });

    const readyResponse = await app.inject({ method: 'GET', url: '/readyz' });
    expect(readyResponse.statusCode).toBe(200);
    expect(readyResponse.json()).toEqual({ status: 'ready', buildSha: 'test-build-sha' });
  });

  it('keeps the build revision visible when readiness fails', async () => {
    query.mockRejectedValueOnce(new Error('database unavailable'));

    const readyResponse = await app.inject({ method: 'GET', url: '/readyz' });

    expect(readyResponse.statusCode).toBe(503);
    expect(readyResponse.json()).toEqual({ status: 'not_ready', buildSha: 'test-build-sha' });
  });

  it('uses the SPA fallback without hiding missing API routes', async () => {
    const webResponse = await app.inject({
      method: 'GET',
      url: '/providers',
      headers: { accept: 'text/html' },
    });
    expect(webResponse.statusCode).toBe(200);
    expect(webResponse.body).toContain('<title>xRouter</title>');

    const apiResponse = await app.inject({
      method: 'GET',
      url: '/api',
      headers: { accept: 'text/html' },
    });
    expect(apiResponse.statusCode).toBe(404);
    expect(apiResponse.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('accepts the current browser origin without a configured public URL', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: 'router.example.test', origin: 'http://router.example.test' },
      payload: { username: 'admin', password: 'not-the-password' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_credentials' } });
  });

  it('rejects a foreign browser origin', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: 'router.example.test', origin: 'https://attacker.example' },
      payload: { username: 'admin', password: 'not-the-password' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'origin_rejected' } });
  });
});
