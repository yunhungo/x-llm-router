import { describe, expect, it } from 'vitest';

import { openAiProviderAdapter } from '../providers/openai';
import type { ProviderRuntime } from '../services/providers';

const oauthProvider: ProviderRuntime = {
  id: 'provider-1',
  name: 'OpenAI',
  provider: 'openai',
  authType: 'oauth',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  defaultModel: 'gpt-5.6-luna',
  authorization: 'Bearer test-token',
  headers: {},
};

const apiKeyProvider: ProviderRuntime = {
  ...oauthProvider,
  id: 'provider-2',
  authType: 'api_key',
  baseUrl: 'https://api.openai.com/v1',
};

describe('gateway upstream request transformation', () => {
  it('converts an OpenAI Responses string input for the ChatGPT Codex backend', () => {
    const transformed = openAiProviderAdapter.prepareRequest(
      'responses',
      {
        model: 'gpt-5.6-luna',
        input: 'Hello',
      },
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
    const transformed = openAiProviderAdapter.prepareRequest(
      'responses',
      { model, input: [] },
      oauthProvider,
    );

    expect(transformed.body.model).toBe(expected);
  });

  it('preserves structured Responses input items', () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }];
    const transformed = openAiProviderAdapter.prepareRequest('responses', { input }, oauthProvider);

    expect(transformed.body.input).toBe(input);
  });

  it('routes OAuth Chat Completions through Responses', () => {
    const transformed = openAiProviderAdapter.prepareRequest(
      'chat.completions',
      {
        model: 'gpt-5.6-luna',
        messages: [{ role: 'user', content: 'Hello' }],
      },
      oauthProvider,
    );

    expect(transformed.path).toBe('/responses');
    expect(transformed.responseMode).toBe('responses-to-chat-completions');
    expect(transformed.body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
    ]);
  });

  it('keeps API key Chat Completions as a direct upstream request', () => {
    const body = {
      model: 'gpt-5.6-luna',
      messages: [{ role: 'user', content: 'Hello' }],
    };
    const transformed = openAiProviderAdapter.prepareRequest(
      'chat.completions',
      body,
      apiKeyProvider,
    );

    expect(transformed.path).toBe('/chat/completions');
    expect(transformed.responseMode).toBe('passthrough');
    expect(transformed.body.messages).toBe(body.messages);
  });
});
