import { describe, expect, it } from 'vitest';

import type { ProviderRuntime } from '../services/providers';
import { deepSeekProviderAdapter, openAiCompatibleProviderAdapter } from './openai-compatible';
import { providerCatalog } from './registry';

const deepSeekProvider: ProviderRuntime = {
  id: 'provider-deepseek',
  name: 'DeepSeek',
  provider: 'deepseek',
  authType: 'api_key',
  baseUrl: 'https://api.deepseek.com',
  defaultModel: 'deepseek-v4-flash',
  authorization: 'Bearer test-token',
  headers: {},
};

describe('OpenAI-compatible provider adapters', () => {
  it('publishes DeepSeek defaults in the provider catalog', () => {
    expect(providerCatalog()).toContainEqual(
      expect.objectContaining({
        id: 'deepseek',
        name: 'DeepSeek',
        defaultApiBaseUrl: 'https://api.deepseek.com',
        defaultModel: 'deepseek-v4-flash',
        capabilities: expect.objectContaining({
          gatewayApis: ['chat.completions'],
          supportsOAuth: false,
        }),
      }),
    );
  });

  it('routes DeepSeek Chat Completions directly upstream', () => {
    const prepared = deepSeekProviderAdapter.prepareRequest(
      'chat.completions',
      { messages: [{ role: 'user', content: 'Hello' }] },
      deepSeekProvider,
    );

    expect(prepared).toMatchObject({
      path: '/chat/completions',
      responseMode: 'passthrough',
      body: { model: 'deepseek-v4-flash' },
    });
  });

  it('rejects Responses for DeepSeek until a protocol bridge is registered', () => {
    expect(() =>
      deepSeekProviderAdapter.prepareRequest('responses', { input: 'Hello' }, deepSeekProvider),
    ).toThrow(/does not support the responses endpoint/);
  });

  it('passes compatible SSE chunks through unchanged', () => {
    const bridge = deepSeekProviderAdapter.createStreamBridge(
      deepSeekProviderAdapter.prepareRequest(
        'chat.completions',
        { model: 'deepseek-v4-flash', messages: [], stream: true },
        deepSeekProvider,
      ),
    );
    const chunk = new TextEncoder().encode(
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
    );

    expect(bridge.feed(chunk)).toEqual([chunk]);
    expect(bridge.usage).toMatchObject({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
  });

  it('limits a custom compatible provider to Chat Completions', () => {
    const provider = { ...deepSeekProvider, provider: 'openai-compatible' };

    expect(() =>
      openAiCompatibleProviderAdapter.prepareRequest('responses', { input: 'Hello' }, provider),
    ).toThrow(/does not support the responses endpoint/);
  });
});
