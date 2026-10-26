/**
 * @created 2026-08-10
 * @description 验证 OAuth 元数据、公共账号目录及设备授权错误。
 * @author yunhungo
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetConfigForTests } from '../config';
import { discoverOpenAiModels, startDeviceFlow, tokenMetadata } from './openai-oauth';

function jwt(payload: object): string {
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.`;
}

describe('OpenAI OAuth token metadata', () => {
  it('extracts expiry and ChatGPT account id', () => {
    const metadata = tokenMetadata(
      jwt({
        exp: 2_000_000_000,
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' },
      }),
    );
    expect(metadata.accountId).toBe('acct_123');
    expect(metadata.expiresAt?.toISOString()).toBe('2033-05-18T03:33:20.000Z');
  });
});

describe('OpenAI OAuth model discovery', () => {
  const originalEnvironment = {
    DATABASE_URL: process.env.DATABASE_URL,
    OPENAI_CODEX_CLIENT_VERSION: process.env.OPENAI_CODEX_CLIENT_VERSION,
  };

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://example';
    process.env.OPENAI_CODEX_CLIENT_VERSION = '0.147.0';
    resetConfigForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetConfigForTests();
  });

  it('returns unique visible model slugs with the account context', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          models: [
            { slug: 'gpt-5.6-sol', visibility: 'list' },
            { slug: 'gpt-5.6-sol', visibility: 'list' },
            { slug: 'gpt-5.6-terra', visibility: 'list' },
            { slug: 'codex-auto-review', visibility: 'hide' },
            { visibility: 'list' },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      discoverOpenAiModels({
        authType: 'oauth',
        baseUrl: 'https://chatgpt.com/backend-api/codex///',
        authorization: 'Bearer access-token',
        headers: { 'ChatGPT-Account-Id': 'account-1', version: '0.147.0' },
      }),
    ).resolves.toEqual({
      models: ['gpt-5.6-sol', 'gpt-5.6-terra'],
      source: 'openai',
      clientVersion: null,
      warning: null,
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://api.openai.com/v1/models');
    expect(init?.headers).toEqual({
      accept: 'application/json',
      authorization: 'Bearer access-token',
    });
  });

  it('rejects a successful response without a model collection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{}', { status: 200 })),
    );

    await expect(
      discoverOpenAiModels({
        authType: 'oauth',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        authorization: 'Bearer access-token',
      }),
    ).rejects.toMatchObject({ code: 'model_catalog_invalid_response' });
  });
});

describe('OpenAI OAuth device authorization errors', () => {
  const originalEnvironment = {
    DATABASE_URL: process.env.DATABASE_URL,
    CHATGPT_AUTH_BASE: process.env.CHATGPT_AUTH_BASE,
  };

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://example';
    process.env.CHATGPT_AUTH_BASE = 'https://auth.openai.com';
    resetConfigForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetConfigForTests();
  });

  it('returns an actionable public error when OpenAI cannot be reached', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      startDeviceFlow({ name: 'OpenAI OAuth', createdBy: 'user-1' }),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: 'openai_oauth_unavailable',
      exposeMessage: true,
      message: expect.stringContaining('HTTPS_PROXY'),
    });
  });

  it('keeps the nested OpenAI rejection message', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Device code login is not enabled.' } }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      startDeviceFlow({ name: 'OpenAI OAuth', createdBy: 'user-1' }),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: 'openai_oauth_rejected',
      exposeMessage: true,
      message: expect.stringContaining('Device code login is not enabled.'),
    });
  });

  it.each([429, 503])('treats upstream HTTP %i as retryable unavailability', async (status) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Try again later.' } }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      startDeviceFlow({ name: 'OpenAI OAuth', createdBy: 'user-1' }),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: 'openai_oauth_unavailable',
      exposeMessage: true,
      message: expect.stringContaining('Try again later.'),
    });
  });

  it.each([
    ['a null body', null, '缺少必要字段'],
    [
      'an invalid polling interval',
      { device_auth_id: 'device-1', user_code: 'ABCD-EFGH', interval: 'not-a-number' },
      '无效轮询间隔',
    ],
  ])('rejects %s from a successful upstream response', async (_label, body, message) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      startDeviceFlow({ name: 'OpenAI OAuth', createdBy: 'user-1' }),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: 'openai_oauth_invalid_response',
      exposeMessage: true,
      message: expect.stringContaining(message),
    });
  });
});
