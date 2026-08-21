import { describe, expect, it } from 'vitest';

import { SseAccumulator } from './sse';

describe('SSE accumulator', () => {
  it('recovers a completed Responses payload across chunks', () => {
    const parser = new SseAccumulator();
    parser.feed(
      Buffer.from(
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":2,',
      ),
    );
    parser.feed(Buffer.from('"output_tokens":3,"total_tokens":5}}}\n\n'));
    parser.feed(new Uint8Array(), true);
    expect(parser.completedResponse?.id).toBe('resp_1');
    expect(parser.usage.totalTokens).toBe(5);
  });

  it('separates first generated reasoning from first visible output', () => {
    const parser = new SseAccumulator();
    parser.feed(Buffer.from('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n'));
    expect(parser.hasGeneratedOutput).toBe(false);
    expect(parser.hasVisibleOutput).toBe(false);

    parser.feed(Buffer.from('data: {"type":"response.reasoning_text.delta","delta":"Think"}\n\n'));
    expect(parser.hasGeneratedOutput).toBe(true);
    expect(parser.hasVisibleOutput).toBe(false);

    parser.feed(Buffer.from('data: {"type":"response.output_text.delta","delta":"Hi"}\n\n'));
    expect(parser.hasGeneratedOutput).toBe(true);
    expect(parser.hasVisibleOutput).toBe(true);
  });

  it('reconstructs a completed Chat Completions response from streamed deltas', () => {
    const parser = new SseAccumulator();
    const events = [
      {
        id: 'chatcmpl_1',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: 'stealth/ox-alpha',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl_1',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: 'stealth/ox-alpha',
        choices: [{ index: 0, delta: { content: '{\"ok\":' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl_1',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: 'stealth/ox-alpha',
        choices: [{ index: 0, delta: { content: 'true}' }, finish_reason: 'stop' }],
      },
      {
        id: 'chatcmpl_1',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: 'stealth/ox-alpha',
        choices: [],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
      },
    ];

    parser.feed(Buffer.from(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')));
    parser.feed(Buffer.from('data: [DONE]\n\n'), true);

    expect(parser.completedResponse).toEqual({
      id: 'chatcmpl_1',
      created: 1_700_000_000,
      model: 'stealth/ox-alpha',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '{\"ok\":true}' },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
    });
    expect(parser.usage).toEqual({
      inputTokens: 4,
      cachedInputTokens: 0,
      outputTokens: 3,
      reasoningTokens: 0,
      totalTokens: 7,
    });
  });

  it('reconstructs streamed Chat Completions tool calls', () => {
    const parser = new SseAccumulator();
    const events = [
      {
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{\"q\":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '\"x\"}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ];

    parser.feed(
      Buffer.from(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')),
      true,
    );

    expect(parser.completedResponse).toMatchObject({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'lookup', arguments: '{\"q\":\"x\"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
  });
});
