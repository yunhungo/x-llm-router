/**
 * @created 2026-08-12
 * @description 验证目录持久化、失败保留及并发刷新合并。
 * @author yunhungo
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { discoverOpenAiModels, query, refreshOAuthCredentials } = vi.hoisted(() => ({
  discoverOpenAiModels: vi.fn(),
  query: vi.fn(),
  refreshOAuthCredentials: vi.fn(),
}));

vi.mock('../db/client', () => ({
  getPool: () => ({ query }),
}));

vi.mock('../lib/crypto', () => ({
  decryptJson: () => ({
    apiKey: 'api-key',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    idToken: 'id-token',
  }),
  encryptJson: vi.fn(),
}));

vi.mock('./openai-oauth', () => ({
  codexClientHeaders: () => ({
    originator: 'codex_cli_rs',
    'user-agent': 'x-llm-router/0.147.0',
    version: '0.147.0',
  }),
  discoverOpenAiModels,
  refreshOAuthCredentials,
}));

import { getProviderRuntime, refreshProviderModels } from './providers';

describe('provider model refresh', () => {
  beforeEach(() => {
    query.mockReset();
    discoverOpenAiModels.mockReset();
    refreshOAuthCredentials.mockReset();
  });

  it('discovers and stores models for an active OAuth connection', async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'provider-1',
            name: 'OpenAI OAuth',
            provider: 'openai',
            auth_type: 'oauth',
            api_mode: 'responses',
            credentials_ciphertext: 'encrypted',
            account_id: 'account-1',
            base_url: 'https://chatgpt.com/backend-api/codex',
            default_model: null,
            token_expires_at: new Date(Date.now() + 3_600_000),
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    discoverOpenAiModels.mockResolvedValueOnce({
      models: ['gpt-5.6-sol', 'gpt-5.6-terra'],
      source: 'openai',
      clientVersion: null,
      warning: null,
    });

    await expect(refreshProviderModels('provider-1')).resolves.toMatchObject({
      models: ['gpt-5.6-sol', 'gpt-5.6-terra'],
    });

    expect(discoverOpenAiModels).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        authorization: 'Bearer access-token',
        headers: expect.objectContaining({ 'ChatGPT-Account-Id': 'account-1' }),
      }),
    );
    expect(query.mock.calls[1]?.[0]).toContain('available_models = $2::jsonb');
    expect(query.mock.calls[1]?.[1]?.[1]).toBe(JSON.stringify(['gpt-5.6-sol', 'gpt-5.6-terra']));
  });

  it('uses the configured Codex client version for OAuth requests', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'provider-1',
          name: 'OpenAI OAuth',
          provider: 'openai',
          auth_type: 'oauth',
          api_mode: 'responses',
          credentials_ciphertext: 'encrypted',
          account_id: 'account-1',
          base_url: 'https://chatgpt.com/backend-api/codex',
          default_model: null,
          token_expires_at: new Date(Date.now() + 3_600_000),
        },
      ],
      rowCount: 1,
    });

    await expect(getProviderRuntime('provider-1', 'session-1', 'responses')).resolves.toMatchObject(
      {
        headers: {
          originator: 'codex_cli_rs',
          'user-agent': 'x-llm-router/0.147.0',
          version: '0.147.0',
          session_id: 'session-1',
          'ChatGPT-Account-Id': 'account-1',
        },
      },
    );
  });

  it('fetches current account models for OpenAI API-key connections', async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'provider-1',
            name: 'OpenAI API',
            provider: 'openai',
            auth_type: 'api_key',
            api_mode: 'responses',
            credentials_ciphertext: 'encrypted',
            account_id: null,
            base_url: 'https://api.openai.com/v1',
            default_model: null,
            token_expires_at: null,
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    discoverOpenAiModels.mockResolvedValueOnce({
      models: ['new-api-model'],
      source: 'upstream',
      clientVersion: null,
      warning: null,
    });
    const result = await refreshProviderModels('provider-1');
    expect(result.models).toContain('new-api-model');
    expect(discoverOpenAiModels).toHaveBeenCalledWith(
      expect.objectContaining({ authType: 'api_key' }),
    );
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('preserves the last successful catalog and time after a discovery failure', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'failed-provider',
          auth_type: 'api_key',
          provider: 'openai',
          base_url: 'https://api.openai.com/v1',
        },
      ],
    });
    query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    discoverOpenAiModels.mockRejectedValueOnce(new Error('catalog offline'));

    await expect(refreshProviderModels('failed-provider')).rejects.toThrow('catalog offline');
    const update = query.mock.calls[1];
    expect(update?.[0]).toContain('models_refresh_error = $2');
    expect(update?.[0]).toContain('models_checked_at = now()');
    expect(update?.[0]).not.toContain('available_models =');
    expect(update?.[0]).not.toContain('models_refreshed_at =');
  });

  it('shares one model request between automatic and manual refreshes', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'shared-provider',
          auth_type: 'api_key',
          provider: 'openai',
          base_url: 'https://api.openai.com/v1',
        },
      ],
    });
    query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    discoverOpenAiModels.mockResolvedValueOnce({
      models: ['fresh'],
      source: 'upstream',
      clientVersion: null,
      warning: null,
    });

    const results = await Promise.all([
      refreshProviderModels('shared-provider'),
      refreshProviderModels('shared-provider'),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(discoverOpenAiModels).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('shares a rotating OAuth renewal between model synchronization and inference', async () => {
    const row = {
      id: 'rotating-provider',
      name: 'OAuth',
      provider: 'openai',
      auth_type: 'oauth',
      api_mode: 'responses',
      credentials_ciphertext: 'encrypted',
      account_id: 'old-account',
      base_url: 'https://chatgpt.com/backend-api/codex',
      default_model: null,
      token_expires_at: new Date(0),
    };
    query.mockResolvedValue({ rows: [row], rowCount: 1 });
    refreshOAuthCredentials.mockResolvedValueOnce({
      credentials: {
        accessToken: 'renewed-access',
        refreshToken: 'renewed-refresh',
        idToken: 'renewed-id',
      },
      expiresAt: new Date(Date.now() + 3_600_000),
      accountId: 'renewed-account',
    });
    discoverOpenAiModels.mockResolvedValueOnce({
      models: ['new-model'],
      source: 'openai',
      clientVersion: null,
      warning: null,
    });

    const [runtime] = await Promise.all([
      getProviderRuntime('rotating-provider', 'session-1', 'responses'),
      refreshProviderModels('rotating-provider'),
    ]);
    expect(refreshOAuthCredentials).toHaveBeenCalledOnce();
    expect(runtime.authorization).toBe('Bearer renewed-access');
    expect(runtime.headers['ChatGPT-Account-Id']).toBe('renewed-account');
    expect(discoverOpenAiModels).toHaveBeenCalledWith(
      expect.objectContaining({ authorization: 'Bearer renewed-access' }),
    );
  });

  it('persists compatibility warnings separately from synchronization failures', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'legacy-provider',
          auth_type: 'api_key',
          provider: 'openai',
          base_url: 'https://api.openai.com/v1',
        },
      ],
    });
    query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    discoverOpenAiModels.mockResolvedValueOnce({
      models: ['compatible'],
      source: 'codex',
      clientVersion: '0.164.0',
      warning: 'legacy authorization',
    });
    await expect(refreshProviderModels('legacy-provider')).resolves.toMatchObject({
      source: 'codex',
      warning: 'legacy authorization',
    });
    expect(query.mock.calls[1]?.[1]?.slice(3)).toEqual([
      'codex',
      '0.164.0',
      'legacy authorization',
    ]);
    expect(query.mock.calls[1]?.[0]).toContain('models_refresh_error = NULL');
  });
});
