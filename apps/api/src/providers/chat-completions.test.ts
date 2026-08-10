import { describe, expect, it } from 'vitest';

import {
  chatCompletionsToResponses,
  ResponsesToChatStreamBridge,
  responsesToChatCompletion,
} from './chat-completions';

describe('Chat Completions and Responses conversion', () => {
  it('converts messages, function tools, calls and tool results to Responses input items', () => {
    const result = chatCompletionsToResponses({
      model: 'gpt-5.6-luna',
      messages: [
        { role: 'user', content: 'Weather in Shanghai?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_weather',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_weather', content: '{"temperature":28}' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ],
    });

    expect(result.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Weather in Shanghai?' }] },
      {
        type: 'function_call',
        call_id: 'call_weather',
        name: 'get_weather',
        arguments: '{"city":"Shanghai"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_weather',
        output: '{"temperature":28}',
      },
    ]);
    expect(result.tools).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ]);
  });

  it('converts a completed Responses payload to Chat Completions', () => {
    const result = responsesToChatCompletion({
      id: 'resp_123',
      model: 'gpt-5.6-luna',
      created_at: 1_700_000_000,
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'lookup',
          arguments: '{"q":"x"}',
        },
      ],
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 4 },
        output_tokens: 3,
        total_tokens: 13,
      },
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      id: 'resp_123',
      object: 'chat.completion',
      model: 'gpt-5.6-luna',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Hello',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'lookup', arguments: '{"q":"x"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 3,
        total_tokens: 13,
        prompt_tokens_details: { cached_tokens: 4 },
      },
    });
  });

  it('translates Responses text SSE into Chat Completions chunks and preserves usage', () => {
    const bridge = new ResponsesToChatStreamBridge('gpt-5.6-luna', true);
    const events = [
      {
        type: 'response.created',
        response: { id: 'resp_1', model: 'gpt-5.6-luna', created_at: 1_700_000_000 },
      },
      { type: 'response.output_text.delta', delta: 'Hello' },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          model: 'gpt-5.6-luna',
          created_at: 1_700_000_000,
          output: [],
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        },
      },
    ];
    const input = new TextEncoder().encode(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    );
    const chunks = bridge.feed(input);
    bridge.feed(new Uint8Array(), true);
    const text = chunks.map((chunk) => new TextDecoder().decode(chunk)).join('');

    expect(text).toContain('"role":"assistant"');
    expect(text).toContain('"content":"Hello"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain('"usage":{"prompt_tokens":2');
    expect(text).toContain('data: [DONE]');
    expect(bridge.usage).toEqual({
      inputTokens: 2,
      cachedInputTokens: 0,
      outputTokens: 1,
      totalTokens: 3,
    });
    expect(bridge.completedResponse).toMatchObject({ object: 'chat.completion' });
  });
});
