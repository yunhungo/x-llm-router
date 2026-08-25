import type { AssistantMessage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import {
  chatCompletionFromPi,
  openAiUsage,
  PiOpenAiStreamSerializer,
  responseFromPi,
} from './pi-openai';

const message: AssistantMessage = {
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: 'reason' },
    { type: 'text', text: 'answer' },
    { type: 'toolCall', id: 'call-1', name: 'lookup', arguments: { id: 42 } },
  ],
  api: 'openai-completions',
  provider: 'openrouter',
  model: 'vendor/model',
  responseModel: 'vendor/model:served',
  responseId: 'gen-1',
  usage: {
    input: 9,
    cacheRead: 3,
    cacheWrite: 0,
    output: 7,
    reasoning: 4,
    totalTokens: 19,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 },
  },
  stopReason: 'toolUse',
  timestamp: 1_700_000_000_000,
};

describe('Pi normalized OpenAI output', () => {
  it('creates a Chat Completions result with reasoning, tools, and usage', () => {
    expect(chatCompletionFromPi(message, 'fallback')).toMatchObject({
      id: 'gen-1',
      model: 'vendor/model:served',
      choices: [
        {
          message: {
            content: 'answer',
            reasoning_content: 'reason',
            tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: '{"id":42}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 7,
        completion_tokens_details: { reasoning_tokens: 4 },
      },
    });
  });

  it('creates a Responses result from the same Pi message', () => {
    expect(responseFromPi(message, 'fallback')).toMatchObject({
      id: 'gen-1',
      status: 'completed',
      model: 'vendor/model:served',
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'reason' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
        { type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{"id":42}' },
      ],
      usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
    });
  });

  it('does not invent a reasoning breakdown when Pi did not report one', () => {
    const { reasoning: _reasoning, ...usage } = message.usage;
    expect(openAiUsage(usage)).not.toHaveProperty('completion_tokens_details');
  });

  it('emits the final streaming usage only when requested', () => {
    const withUsage = new PiOpenAiStreamSerializer('chat.completions', message.model, true)
      .feed({ type: 'done', reason: 'toolUse', message })
      .map((chunk) => new TextDecoder().decode(chunk))
      .join('');
    const withoutUsage = new PiOpenAiStreamSerializer('chat.completions', message.model, false)
      .feed({ type: 'done', reason: 'toolUse', message })
      .map((chunk) => new TextDecoder().decode(chunk))
      .join('');
    expect(withUsage).toContain('"usage"');
    expect(withUsage).toContain('[DONE]');
    expect(withoutUsage).not.toContain('"usage"');
  });
});
