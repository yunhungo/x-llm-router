import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderRuntime } from '../services/providers';
import {
  getPiProviderDefinition,
  piProviderCatalog,
  preparePiRequest,
  tokenUsageFromPi,
} from './pi-ai';

const runtime: ProviderRuntime = {
  id: 'provider-1',
  name: 'Custom upstream',
  provider: 'custom',
  authType: 'api_key',
  apiMode: 'chat.completions',
  baseUrl: 'https://upstream.example/v1',
  defaultModel: null,
  authorization: 'Bearer secret-api-key',
  apiKey: 'secret-api-key',
  headers: {},
};

function openAiChatStream(): Response {
  const chunks = [
    {
      id: 'gen-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'vendor/reasoner',
      choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'think ' } }],
    },
    {
      id: 'gen-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'vendor/reasoner',
      choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }],
    },
    {
      id: 'gen-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'vendor/reasoner',
      choices: [],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 7,
        total_tokens: 19,
        prompt_tokens_details: { cached_tokens: 3 },
        completion_tokens_details: { reasoning_tokens: 4 },
      },
    },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-provider': 'mock' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('Pi AI provider registry', () => {
  it('registers built-in and custom API-key providers', () => {
    const ids = piProviderCatalog().map((provider) => provider.id);
    expect(ids).toContain('openai');
    expect(ids).toContain('openrouter');
    expect(ids).toContain('anthropic');
    expect(ids).toContain('custom');
    expect(getPiProviderDefinition('openrouter')?.models.length).toBeGreaterThan(100);
  });
});

describe('Pi AI request execution', () => {
  it('lets Pi send and normalize an OpenAI-compatible stream', async () => {
    const fetchMock = vi.fn(async () => openAiChatStream());
    vi.stubGlobal('fetch', fetchMock);
    const prepared = preparePiRequest(
      'chat.completions',
      {
        model: 'vendor/reasoner',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
        provider: { order: ['Provider A'] },
      },
      runtime,
      new AbortController().signal,
      'request-1',
    );

    const events = [];
    for await (const event of prepared.events) events.push(event);
    const done = events.find((event) => event.type === 'done');

    expect(done).toMatchObject({
      type: 'done',
      message: {
        content: [
          { type: 'thinking', thinking: 'think ' },
          { type: 'text', text: 'answer' },
        ],
        usage: { input: 9, cacheRead: 3, output: 7, reasoning: 4, totalTokens: 19 },
      },
    });
    if (!done || done.type !== 'done') throw new Error('Expected a completed Pi message.');
    expect(tokenUsageFromPi(done.message.usage)).toEqual({
      inputTokens: 12,
      cachedInputTokens: 3,
      outputTokens: 7,
      reasoningTokens: 4,
      totalTokens: 19,
    });
    expect(prepared.capture.request).toMatchObject({
      method: 'POST',
      url: 'https://upstream.example/v1/chat/completions',
      body: {
        model: 'vendor/reasoner',
        stream: true,
        provider: { order: ['Provider A'] },
        stream_options: { include_usage: true },
      },
    });
    expect(prepared.capture.response).toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('converts a Responses request when the custom upstream uses Chat Completions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => openAiChatStream()),
    );
    const prepared = preparePiRequest(
      'responses',
      { model: 'vendor/reasoner', input: 'hello', stream: false },
      runtime,
      new AbortController().signal,
      'request-2',
    );
    for await (const _event of prepared.events) {
      // Consume the normalized Pi stream.
    }

    expect(prepared.capture.request?.body).toMatchObject({
      model: 'vendor/reasoner',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    });
    expect(prepared.capture.request?.body).not.toHaveProperty('input');
  });

  it('does not inject an unsupported custom fetch into the Google adapter', async () => {
    const definition = getPiProviderDefinition('google');
    if (!definition?.models[0]) throw new Error('Expected the Google Pi provider.');
    const controller = new AbortController();
    controller.abort();
    const prepared = preparePiRequest(
      'chat.completions',
      {
        model: definition.models[0],
        messages: [{ role: 'user', content: 'hello' }],
      },
      {
        ...runtime,
        provider: 'google',
        name: 'Google',
        baseUrl: definition.defaultApiBaseUrl,
      },
      controller.signal,
      'request-3',
    );

    const events = [];
    for await (const event of prepared.events) events.push(event);
    const error = events.find((event) => event.type === 'error');
    expect(error).toMatchObject({ type: 'error', reason: 'aborted' });
    if (!error || error.type !== 'error') throw new Error('Expected an aborted Pi event.');
    expect(error.error.errorMessage).not.toContain('Custom fetch is not supported');
  });
});
