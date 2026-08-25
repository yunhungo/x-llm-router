import { randomUUID } from 'node:crypto';

import type {
  AssistantMessage,
  AssistantMessageEvent,
  ToolCall,
  Usage,
} from '@earendil-works/pi-ai';

import type { GatewayEndpoint } from './types';

function responseModel(message: AssistantMessage, fallback: string): string {
  return message.responseModel || message.model || fallback;
}

function finishReason(message: AssistantMessage): string {
  if (message.stopReason === 'length') return 'length';
  if (message.stopReason === 'toolUse') return 'tool_calls';
  return 'stop';
}

export function openAiUsage(usage: Usage): Record<string, unknown> {
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: usage.output,
    total_tokens: usage.totalTokens,
    prompt_tokens_details: { cached_tokens: usage.cacheRead },
    ...(usage.reasoning === undefined
      ? {}
      : { completion_tokens_details: { reasoning_tokens: usage.reasoning } }),
  };
}

function responsesUsage(usage: Usage): Record<string, unknown> {
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: usage.cacheRead },
    output_tokens: usage.output,
    output_tokens_details: { reasoning_tokens: usage.reasoning ?? 0 },
    total_tokens: usage.totalTokens,
  };
}

function chatToolCall(toolCall: ToolCall): Record<string, unknown> {
  return {
    id: toolCall.id,
    type: 'function',
    function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
  };
}

export function chatCompletionFromPi(
  message: AssistantMessage,
  fallbackModel: string,
  id = message.responseId || `chatcmpl_${randomUUID()}`,
): Record<string, unknown> {
  const text = message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
  const reasoning = message.content
    .filter((part) => part.type === 'thinking')
    .map((part) => part.thinking)
    .join('');
  const tools = message.content.filter((part): part is ToolCall => part.type === 'toolCall');
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(message.timestamp / 1000),
    model: responseModel(message, fallbackModel),
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(tools.length ? { tool_calls: tools.map(chatToolCall) } : {}),
        },
        finish_reason: finishReason(message),
        logprobs: null,
      },
    ],
    usage: openAiUsage(message.usage),
  };
}

function responseOutput(
  message: AssistantMessage,
  itemIds?: ReadonlyMap<number, string>,
): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  const thinking = message.content
    .filter((part) => part.type === 'thinking')
    .map((part) => part.thinking)
    .join('');
  if (thinking) {
    const index = message.content.findIndex((part) => part.type === 'thinking');
    output.push({
      id: itemIds?.get(index) ?? `rs_${randomUUID()}`,
      type: 'reasoning',
      status: 'completed',
      summary: [{ type: 'summary_text', text: thinking }],
    });
  }
  const text = message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
  if (text) {
    const index = message.content.findIndex((part) => part.type === 'text');
    output.push({
      id: itemIds?.get(index) ?? `msg_${randomUUID()}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
    });
  }
  for (const [index, part] of message.content.entries()) {
    if (part.type !== 'toolCall') continue;
    const toolCall = part;
    output.push({
      id: itemIds?.get(index) ?? `fc_${randomUUID()}`,
      type: 'function_call',
      status: 'completed',
      call_id: toolCall.id,
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.arguments),
    });
  }
  return output;
}

export function responseFromPi(
  message: AssistantMessage,
  fallbackModel: string,
  id = message.responseId || `resp_${randomUUID()}`,
  itemIds?: ReadonlyMap<number, string>,
): Record<string, unknown> {
  return {
    id,
    object: 'response',
    created_at: Math.floor(message.timestamp / 1000),
    status: 'completed',
    background: false,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: responseModel(message, fallbackModel),
    output: responseOutput(message, itemIds),
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: null,
    store: false,
    temperature: null,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    truncation: 'disabled',
    usage: responsesUsage(message.usage),
    user: null,
    metadata: {},
  };
}

function sse(event: string | undefined, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`,
  );
}

export class PiOpenAiStreamSerializer {
  private readonly id: string;
  private readonly created = Math.floor(Date.now() / 1000);
  private sequence = 0;
  private readonly itemIds = new Map<number, string>();
  private readonly toolIndexes = new Map<number, number>();
  private nextToolIndex = 0;

  constructor(
    private readonly endpoint: GatewayEndpoint,
    private readonly model: string,
    private readonly includeUsage: boolean,
  ) {
    this.id = endpoint === 'responses' ? `resp_${randomUUID()}` : `chatcmpl_${randomUUID()}`;
  }

  feed(event: AssistantMessageEvent): Uint8Array[] {
    return this.endpoint === 'responses' ? this.responses(event) : this.chat(event);
  }

  private chat(event: AssistantMessageEvent): Uint8Array[] {
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      sse(undefined, {
        id: this.id,
        object: 'chat.completion.chunk',
        created: this.created,
        model: this.model,
        choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
      });
    if (event.type === 'start') return [chunk({ role: 'assistant', content: '' })];
    if (event.type === 'text_delta') return [chunk({ content: event.delta })];
    if (event.type === 'thinking_delta') return [chunk({ reasoning_content: event.delta })];
    if (event.type === 'toolcall_delta') {
      const partial = event.partial.content[event.contentIndex];
      if (!partial || partial.type !== 'toolCall') return [];
      let index = this.toolIndexes.get(event.contentIndex);
      const first = index === undefined;
      if (index === undefined) {
        index = this.nextToolIndex++;
        this.toolIndexes.set(event.contentIndex, index);
      }
      return [
        chunk({
          tool_calls: [
            {
              index,
              ...(first ? { id: partial.id, type: 'function' } : {}),
              function: { ...(first ? { name: partial.name } : {}), arguments: event.delta },
            },
          ],
        }),
      ];
    }
    if (event.type === 'toolcall_end' && !this.toolIndexes.has(event.contentIndex)) {
      const index = this.nextToolIndex++;
      this.toolIndexes.set(event.contentIndex, index);
      return [chunk({ tool_calls: [{ index, ...chatToolCall(event.toolCall) }] })];
    }
    if (event.type === 'done') {
      const result = [chunk({}, finishReason(event.message))];
      if (this.includeUsage) {
        result.push(
          sse(undefined, {
            id: this.id,
            object: 'chat.completion.chunk',
            created: this.created,
            model: responseModel(event.message, this.model),
            choices: [],
            usage: openAiUsage(event.message.usage),
          }),
        );
      }
      result.push(new TextEncoder().encode('data: [DONE]\n\n'));
      return result;
    }
    if (event.type === 'error') {
      return [
        sse(undefined, {
          error: { type: 'api_error', code: 'upstream_error', message: event.error.errorMessage },
        }),
        new TextEncoder().encode('data: [DONE]\n\n'),
      ];
    }
    return [];
  }

  private responses(event: AssistantMessageEvent): Uint8Array[] {
    const emit = (name: string, data: Record<string, unknown>) =>
      sse(name, { type: name, sequence_number: this.sequence++, ...data });
    const outputIndex =
      event.type.includes('_') && 'contentIndex' in event ? event.contentIndex : 0;
    if (event.type === 'start') {
      const response = {
        id: this.id,
        object: 'response',
        created_at: this.created,
        status: 'in_progress',
        model: this.model,
        output: [],
      };
      return [emit('response.created', { response }), emit('response.in_progress', { response })];
    }
    if (event.type === 'text_start') {
      const itemId = `msg_${randomUUID()}`;
      this.itemIds.set(event.contentIndex, itemId);
      return [
        emit('response.output_item.added', {
          output_index: outputIndex,
          item: {
            id: itemId,
            type: 'message',
            status: 'in_progress',
            role: 'assistant',
            content: [],
          },
        }),
        emit('response.content_part.added', {
          item_id: itemId,
          output_index: outputIndex,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
        }),
      ];
    }
    if (event.type === 'text_delta') {
      return [
        emit('response.output_text.delta', {
          item_id: this.itemIds.get(event.contentIndex),
          output_index: outputIndex,
          content_index: 0,
          delta: event.delta,
          logprobs: [],
        }),
      ];
    }
    if (event.type === 'text_end') {
      const itemId = this.itemIds.get(event.contentIndex);
      const item = {
        id: itemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: event.content, annotations: [], logprobs: [] }],
      };
      return [
        emit('response.output_text.done', {
          item_id: itemId,
          output_index: outputIndex,
          content_index: 0,
          text: event.content,
          logprobs: [],
        }),
        emit('response.content_part.done', {
          item_id: itemId,
          output_index: outputIndex,
          content_index: 0,
          part: item.content[0],
        }),
        emit('response.output_item.done', { output_index: outputIndex, item }),
      ];
    }
    if (event.type === 'thinking_start') {
      const itemId = `rs_${randomUUID()}`;
      this.itemIds.set(event.contentIndex, itemId);
      return [
        emit('response.output_item.added', {
          output_index: outputIndex,
          item: { id: itemId, type: 'reasoning', status: 'in_progress', summary: [] },
        }),
        emit('response.reasoning_summary_part.added', {
          item_id: itemId,
          output_index: outputIndex,
          summary_index: 0,
          part: { type: 'summary_text', text: '' },
        }),
      ];
    }
    if (event.type === 'thinking_delta') {
      return [
        emit('response.reasoning_summary_text.delta', {
          item_id: this.itemIds.get(event.contentIndex),
          output_index: outputIndex,
          summary_index: 0,
          delta: event.delta,
        }),
      ];
    }
    if (event.type === 'thinking_end') {
      const itemId = this.itemIds.get(event.contentIndex);
      const part = { type: 'summary_text', text: event.content };
      const item = {
        id: itemId,
        type: 'reasoning',
        status: 'completed',
        summary: [part],
      };
      return [
        emit('response.reasoning_summary_text.done', {
          item_id: itemId,
          output_index: outputIndex,
          summary_index: 0,
          text: event.content,
        }),
        emit('response.reasoning_summary_part.done', {
          item_id: itemId,
          output_index: outputIndex,
          summary_index: 0,
          part,
        }),
        emit('response.output_item.done', { output_index: outputIndex, item }),
      ];
    }
    if (event.type === 'toolcall_end') {
      const itemId = `fc_${randomUUID()}`;
      this.itemIds.set(event.contentIndex, itemId);
      const item = {
        id: itemId,
        type: 'function_call',
        status: 'completed',
        call_id: event.toolCall.id,
        name: event.toolCall.name,
        arguments: JSON.stringify(event.toolCall.arguments),
      };
      return [
        emit('response.output_item.added', {
          output_index: outputIndex,
          item,
        }),
        emit('response.function_call_arguments.done', {
          item_id: itemId,
          output_index: outputIndex,
          arguments: item.arguments,
        }),
        emit('response.output_item.done', { output_index: outputIndex, item }),
      ];
    }
    if (event.type === 'done') {
      return [
        emit('response.completed', {
          response: responseFromPi(event.message, this.model, this.id, this.itemIds),
        }),
        new TextEncoder().encode('data: [DONE]\n\n'),
      ];
    }
    if (event.type === 'error') {
      return [
        emit('response.failed', {
          response: {
            id: this.id,
            object: 'response',
            created_at: this.created,
            status: 'failed',
            error: { code: 'upstream_error', message: event.error.errorMessage },
          },
        }),
        new TextEncoder().encode('data: [DONE]\n\n'),
      ];
    }
    return [];
  }
}

export function finalOpenAiResponse(
  endpoint: GatewayEndpoint,
  message: AssistantMessage,
  fallbackModel: string,
): Record<string, unknown> {
  return endpoint === 'responses'
    ? responseFromPi(message, fallbackModel)
    : chatCompletionFromPi(message, fallbackModel);
}
