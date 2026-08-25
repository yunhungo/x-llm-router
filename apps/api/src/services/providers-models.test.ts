import { beforeEach, describe, expect, it, vi } from 'vitest';

const { discoverOpenAiModels, query } = vi.hoisted(() => ({
  discoverOpenAiModels: vi.fn(),
  query: vi.fn(),
}));

vi.mock('../db/client', () => ({
  getPool: () => ({ query }),
}));

vi.mock('../lib/crypto', () => ({
  decryptJson: () => ({
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
  refreshOAuthCredentials: vi.fn(),
}));

import { getProviderRuntime, refreshProviderModels } from './providers';

describe('provider model refresh', () => {
  beforeEach(() => {
    query.mockReset();
    discoverOpenAiModels.mockReset();
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
    discoverOpenAiModels.mockResolvedValueOnce(['gpt-5.6-sol', 'gpt-5.6-terra']);

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

  it('restores Pi built-in models for API-key connections', async () => {
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

    const result = await refreshProviderModels('provider-1');
    expect(result.models).toContain('gpt-5.6-sol');
    expect(discoverOpenAiModels).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2);
  });
});
