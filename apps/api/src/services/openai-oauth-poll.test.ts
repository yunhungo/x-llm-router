import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../db/client', () => ({
  getPool: () => ({ query }),
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
    CHATGPT_AUTH_BASE: process.env.CHATGPT_AUTH_BASE,
  };

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://example';
    process.env.CHATGPT_AUTH_BASE = 'https://auth.openai.com';
    resetConfigForTests();
    query.mockReset();
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
});
