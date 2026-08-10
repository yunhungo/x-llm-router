import { describe, expect, it } from 'vitest';

import { tokenMetadata } from './openai-oauth';

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
