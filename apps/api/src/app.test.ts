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

describe('embedded web application', () => {
  let app: FastifyInstance;
  let webRoot: string;
  const originalEnvironment = {
    DATABASE_URL: process.env.DATABASE_URL,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
    JWT_SECRET: process.env.JWT_SECRET,
    LOG_LEVEL: process.env.LOG_LEVEL,
    WEB_ROOT: process.env.WEB_ROOT,
  };

  beforeAll(async () => {
    webRoot = await mkdtemp(join(tmpdir(), 'x-router-web-'));
    await mkdir(join(webRoot, 'assets'));
    await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>xRouter</title>');
    await writeFile(join(webRoot, 'assets', 'app.js'), 'globalThis.xRouter = true;');

    process.env.DATABASE_URL = 'postgresql://example';
    process.env.ENCRYPTION_KEY = 'test-encryption-key-with-enough-length';
    process.env.JWT_SECRET = 'test-jwt-secret-with-enough-length';
    process.env.LOG_LEVEL = 'silent';
    process.env.WEB_ROOT = webRoot;
    resetConfigForTests();

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
});
