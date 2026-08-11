import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';

import { openAiProviderAdapter } from '../providers/openai';
import { defaultLangfuseSettings } from '../services/langfuse';
import type { ProviderRuntime } from '../services/providers';
import { gatewayRequestId, langfuseModelParameters, langfuseRequestIdentity } from './gateway';

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
  it('uses a stable API-key identity when clients omit optional Langfuse headers', () => {
    const request = {
      id: 'generated-request-id',
      headers: { 'user-agent': 'Bob/1.20.0 (macOS)' },
    } as unknown as FastifyRequest;

    expect(
      langfuseRequestIdentity(
        request,
        { model: 'deepseek-v4-flash' },
        defaultLangfuseSettings(),
        'key-123',
      ),
    ).toEqual({
      userId: 'api-key:key-123',
      userIdSource: 'api-key',
      sessionIdSource: 'none',
      clientName: 'Bob',
    });
  });

  it('honors explicit identity headers and validates client request IDs', () => {
    const request = {
      id: 'generated-request-id',
      headers: {
        'x-user-id': 'bob-user',
        'x-session-id': 'conversation-42',
        'x-request-id': 'bob-request-42',
      },
    } as unknown as FastifyRequest;

    expect(
      langfuseRequestIdentity(request, {}, defaultLangfuseSettings(), 'key-123'),
    ).toMatchObject({
      userId: 'bob-user',
      userIdSource: 'header:x-user-id',
      sessionId: 'conversation-42',
      sessionIdSource: 'header:x-session-id',
    });
    expect(gatewayRequestId(request)).toBe('bob-request-42');

    const invalid = {
      id: 'also invalid whitespace',
      headers: { 'x-request-id': 'invalid whitespace' },
    } as unknown as FastifyRequest;
    expect(gatewayRequestId(invalid)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

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
