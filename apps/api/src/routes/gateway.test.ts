import { describe, expect, it } from 'vitest';

import type { ProviderRuntime } from '../services/providers';
import { buildUpstreamBody } from './gateway';

const oauthProvider: ProviderRuntime = {
  id: 'provider-1',
  name: 'OpenAI',
  authType: 'oauth',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  defaultModel: 'gpt-5.6-luna',
  authorization: 'Bearer test-token',
  headers: {},
};

describe('gateway upstream request transformation', () => {
  it('converts an OpenAI Responses string input for the ChatGPT Codex backend', () => {
    const transformed = buildUpstreamBody(
      {
        model: 'gpt-5.6-luna',
        input: 'Hello',
      },
      'responses',
      oauthProvider,
    );

    expect(transformed.body.input).toEqual([
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'Hello' }],
      },
    ]);
  });

  it.each([
    ['chatgpt/gpt-5.6-luna', 'gpt-5.6-luna'],
    ['chatgpt-gpt-5.6-luna', 'gpt-5.6-luna'],
    ['gpt-5.6-luna', 'gpt-5.6-luna'],
  ])('normalizes ChatGPT model alias %s', (model, expected) => {
    const transformed = buildUpstreamBody({ model, input: [] }, 'responses', oauthProvider);

    expect(transformed.body.model).toBe(expected);
  });

  it('preserves structured Responses input items', () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }];
    const transformed = buildUpstreamBody({ input }, 'responses', oauthProvider);

    expect(transformed.body.input).toBe(input);
  });
});
