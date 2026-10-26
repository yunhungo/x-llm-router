/**
 * @created 2026-10-26
 * @description 验证公共账号模型目录、旧授权回退与标准兼容接口边界。
 * @author yunhungo
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetConfigForTests } from '../config';
import { discoverOpenAiModels } from './provider-model-catalog';

const oauth = {
  authType: 'oauth',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  authorization: 'Bearer test-access',
  headers: { 'ChatGPT-Account-Id': 'test-account', version: 'old' },
} as const;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('live model catalogs', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', 'postgresql://example');
    vi.stubEnv('OPENAI_API_BASE', 'https://api.openai.com/v1');
    vi.stubEnv('OPENAI_CODEX_CLIENT_VERSION', '0.164.0');
    resetConfigForTests();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetConfigForTests();
  });

  it('accepts new model names without a software release and preserves upstream ordering', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        models: [
          { slug: 'future-model-z', visibility: 'list' },
          { slug: 'gpt-6.1-sol', visibility: 'list' },
          { slug: 'future-model-z', visibility: 'list' },
          { slug: 'internal-review', visibility: 'hide' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(discoverOpenAiModels(oauth)).resolves.toEqual({
      models: ['future-model-z', 'gpt-6.1-sol'],
      source: 'openai',
      clientVersion: null,
      warning: null,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.openai.com/v1/models');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      accept: 'application/json',
      authorization: oauth.authorization,
    });
  });

  it.each([401, 403, 404])(
    'falls back visibly for a legacy authorization rejected with HTTP %i',
    async (status) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response({}, status))
        .mockResolvedValueOnce(response({ models: [{ slug: 'gpt-6-sol', visibility: 'list' }] }));
      vi.stubGlobal('fetch', fetchMock);
      await expect(discoverOpenAiModels(oauth)).resolves.toMatchObject({
        models: ['gpt-6-sol'],
        source: 'codex',
        clientVersion: '0.164.0',
        warning: expect.stringContaining('兼容模型目录'),
      });
      expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
        'https://chatgpt.com/backend-api/codex/models?client_version=0.164.0',
      );
      expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
        'ChatGPT-Account-Id': 'test-account',
        version: '0.164.0',
      });
    },
  );

  it.each([429, 503])(
    'does not hide a transient HTTP %i by claiming a fallback is current',
    async (status) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response({}, status));
      vi.stubGlobal('fetch', fetchMock);
      await expect(discoverOpenAiModels(oauth)).rejects.toThrow(`HTTP ${status}`);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it('does not fallback on a malformed successful catalog', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response({ data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(discoverOpenAiModels(oauth)).rejects.toMatchObject({
      code: 'model_catalog_invalid_response',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('accepts an authoritative empty catalog', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response({ models: [] })));
    await expect(discoverOpenAiModels(oauth)).resolves.toMatchObject({
      models: [],
      source: 'openai',
    });
  });

  it('rejects collections containing only invalid entries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(response({ models: [{ not_a_slug: 'broken' }] })),
    );
    await expect(discoverOpenAiModels(oauth)).rejects.toMatchObject({
      code: 'model_catalog_invalid_response',
    });
  });

  it('does not erase a catalog when the model visibility fields are malformed', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(response({ models: [{ slug: 'missing-visibility' }] })),
    );
    await expect(discoverOpenAiModels(oauth)).rejects.toMatchObject({
      code: 'model_catalog_invalid_response',
    });
  });

  it('queries an API-key upstream using its standard data/id schema without Codex headers', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ data: [{ id: 'new-api-model' }, { id: 'new-api-model' }] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      discoverOpenAiModels({
        authType: 'api_key',
        baseUrl: 'https://upstream.example/v1/',
        authorization: 'Bearer api-key',
      }),
    ).resolves.toMatchObject({ models: ['new-api-model'], source: 'upstream' });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://upstream.example/v1/models');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      accept: 'application/json',
      authorization: 'Bearer api-key',
    });
  });

  it('returns a safe error when the network fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockRejectedValue(new Error('sensitive debug text')),
    );
    await expect(discoverOpenAiModels(oauth)).rejects.toMatchObject({
      message: expect.not.stringContaining('sensitive'),
    });
  });
});
