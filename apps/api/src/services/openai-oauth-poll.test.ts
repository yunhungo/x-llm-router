import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { clientQuery, query, release } = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
}));

vi.mock('../db/client', () => ({
  getPool: () => ({
    query,
    connect: async () => ({ query: clientQuery, release }),
  }),
}));

vi.mock('../lib/crypto', () => ({
  decryptJson: () => ({ deviceAuthId: 'device-auth-1' }),
  encryptJson: vi.fn(),
}));

import { resetConfigForTests } from '../config';
import { pollDeviceFlow } from './openai-oauth';

describe('OpenAI OAuth polling error classification', () => {
  const originalEnvironment = {
    DATABASE_URL: process.env.DATABASE_URL,
    CHATGPT_API_BASE: process.env.CHATGPT_API_BASE,
    CHATGPT_AUTH_BASE: process.env.CHATGPT_AUTH_BASE,
    OPENAI_CODEX_CLIENT_VERSION: process.env.OPENAI_CODEX_CLIENT_VERSION,
  };

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://example';
    process.env.CHATGPT_API_BASE = 'https://chatgpt.com/backend-api/codex';
    process.env.CHATGPT_AUTH_BASE = 'https://auth.openai.com';
    process.env.OPENAI_CODEX_CLIENT_VERSION = '0.147.0';
    resetConfigForTests();
    query.mockReset();
    clientQuery.mockReset();
    release.mockReset();
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'flow-1',
          desired_name: 'OpenAI OAuth',
          device_auth_id_ciphertext: 'encrypted',
          user_code: 'ABCD-EFGH',
          status: 'pending',
          expires_at: new Date(Date.now() + 60_000),
        },
      ],
      rowCount: 1,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetConfigForTests();
  });

  it.each([429, 503])('keeps the flow pending after upstream HTTP %i', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { message: 'Try again later.' } }), { status }),
        ),
    );

    await expect(pollDeviceFlow({ id: 'flow-1', requestedBy: 'user-1' })).rejects.toMatchObject({
      code: 'openai_oauth_unavailable',
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('marks the flow failed after a terminal upstream rejection', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'Authorization rejected.' } }), {
          status: 400,
        }),
      ),
    );

    await expect(pollDeviceFlow({ id: 'flow-1', requestedBy: 'user-1' })).rejects.toMatchObject({
      code: 'openai_oauth_rejected',
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toContain("status = 'failed'");
  });

  it('discovers and stores account models when authorization completes', async () => {
    const accountId = 'account-1';
    const idToken = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(
      JSON.stringify({
        exp: 2_000_000_000,
        'https://api.openai.com/auth': { chatgpt_account_id: accountId },
      }),
    ).toString('base64url')}.`;
    clientQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ authorization_code: 'authorization-1', code_verifier: 'verifier-1' }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-1',
            refresh_token: 'refresh-1',
            id_token: idToken,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: [
              { slug: 'gpt-5.6-sol', visibility: 'list' },
              { slug: 'gpt-5.6-terra', visibility: 'list' },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(pollDeviceFlow({ id: 'flow-1', requestedBy: 'user-1' })).resolves.toMatchObject({
      status: 'complete',
      modelsCount: 2,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const modelRequest = fetchMock.mock.calls[2];
    expect(String(modelRequest?.[0])).toBe(
      'https://chatgpt.com/backend-api/codex/models?client_version=0.147.0',
    );
    expect(modelRequest?.[1]?.headers).toMatchObject({
      'ChatGPT-Account-Id': accountId,
      authorization: 'Bearer access-1',
      version: '0.147.0',
    });

    const insert = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO provider_connections'),
    );
    expect(insert?.[1]?.[7]).toBe(JSON.stringify(['gpt-5.6-sol', 'gpt-5.6-terra']));
    expect(insert?.[1]?.[9]).toBeNull();
    expect(release).toHaveBeenCalledOnce();
  });
});
