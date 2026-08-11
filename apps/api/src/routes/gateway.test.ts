import { describe, expect, it } from 'vitest';

import { openAiProviderAdapter } from '../providers/openai';
import type { ProviderRuntime } from '../services/providers';
import { langfuseModelParameters } from './gateway';

const oauthProvider: ProviderRuntime = {
  id: 'provider-1',
  name: 'OpenAI',
  provider: 'openai',
  authType: 'oauth',
  apiMode: 'responses',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  defaultModel: 'gpt-5.6-luna',
  authorization: 'Bearer test-token',
  headers: {},
};

const apiKeyProvider: ProviderRuntime = {
  ...oauthProvider,
  id: 'provider-2',
  authType: 'api_key',
  apiMode: 'chat.completions',
  baseUrl: 'https://api.openai.com/v1',
};

describe('gateway upstream request transformation', () => {
  it('maps common model parameters to Langfuse generation attributes', () => {
    expect(
      langfuseModelParameters({
        temperature: 0.2,
        top_p: 0.9,
        max_output_tokens: 800,
        service_tier: 'priority',
        reasoning: { effort: 'high' },
        tools: [{ type: 'function' }],
      }),
    ).toEqual({
      temperature: 0.2,
      top_p: 0.9,
      max_output_tokens: 800,
      service_tier: 'priority',
      'reasoning.effort': 'high',
    });
  });

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

  it.each([
    ['responses', '/responses'],
    ['chat.completions', '/chat/completions'],
  ] as const)('routes an API Key connection through its configured %s API', (apiMode, path) => {
    const provider = { ...apiKeyProvider, apiMode };
    const body =
      apiMode === 'responses'
        ? { input: 'Hello' }
        : { messages: [{ role: 'user', content: 'Hello' }] };

    expect(openAiProviderAdapter.prepareRequest(apiMode, body, provider)).toMatchObject({
      path,
      responseMode: 'passthrough',
    });
  });

  it('rejects a request that differs from the API Key connection mode', () => {
    expect(() =>
      openAiProviderAdapter.prepareRequest('responses', { input: 'Hello' }, apiKeyProvider),
    ).toThrow(/configured for the Chat Completions API/);
  });
});
