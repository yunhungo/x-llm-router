import { extractTokenUsage, type TokenUsage } from '../services/usage';
import type { GatewayStreamBridge } from './types';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function badRequest(message: string, code = 'invalid_request'): never {
  throw Object.assign(new Error(message), { statusCode: 400, code });
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');
  return content
    .map((part) => {
      const item = record(part);
      return item?.type === 'text' && typeof item.text === 'string' ? item.text : '';
    })
    .join('');
}

function convertContent(content: unknown): JsonRecord[] {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((part) => {
    const item = record(part);
    if (!item) badRequest('Message content parts must be objects.');
    if (item.type === 'text' && typeof item.text === 'string') {
      return { type: 'input_text', text: item.text };
    }
    if (item.type === 'image_url') {
      const image = record(item.image_url);
      if (!image || typeof image.url !== 'string') {
        badRequest('image_url content requires image_url.url.');
      }
      return {
        type: 'input_image',
        image_url: image.url,
        ...(typeof image.detail === 'string' ? { detail: image.detail } : {}),
      };
    }
    return badRequest(`Unsupported Chat Completions content type: ${String(item.type)}.`);
  });
}

function convertMessages(messages: unknown): JsonRecord[] {
  if (!Array.isArray(messages)) badRequest('messages must be an array.');
  const input: JsonRecord[] = [];
  for (const rawMessage of messages) {
    const message = record(rawMessage);
    if (!message || typeof message.role !== 'string') {
      badRequest('Each message requires a role.');
    }
    if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string') {
        badRequest('Tool messages require tool_call_id.');
      }
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: textFromContent(message.content),
      });
      continue;
    }
    if (!['system', 'developer', 'user', 'assistant'].includes(message.role)) {
      badRequest(`Unsupported message role: ${message.role}.`);
    }
    const content = convertContent(message.content);
    if (content.length > 0) input.push({ role: message.role, content });

    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const rawToolCall of message.tool_calls) {
        const toolCall = record(rawToolCall);
        const fn = record(toolCall?.function);
        if (!toolCall || toolCall.type !== 'function' || !fn || typeof fn.name !== 'string') {
          badRequest('Only function tool calls are supported.');
        }
        input.push({
          type: 'function_call',
          call_id:
            typeof toolCall.id === 'string' ? toolCall.id : `call_${input.length.toString(36)}`,
          name: fn.name,
          arguments: typeof fn.arguments === 'string' ? fn.arguments : '{}',
        });
      }
    }
  }
  return input;
}

function convertTools(tools: unknown): JsonRecord[] | undefined {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) badRequest('tools must be an array.');
  return tools.map((rawTool) => {
    const tool = record(rawTool);
    const fn = record(tool?.function);
    if (!tool || tool.type !== 'function' || !fn || typeof fn.name !== 'string') {
      return badRequest('Only function tools are supported.');
    }
    return {
      type: 'function',
      name: fn.name,
      ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
      ...(record(fn.parameters) ? { parameters: fn.parameters } : {}),
      ...(typeof fn.strict === 'boolean' ? { strict: fn.strict } : {}),
    };
  });
}

function convertToolChoice(toolChoice: unknown): unknown {
  const choice = record(toolChoice);
  if (!choice) return toolChoice;
  const fn = record(choice.function);
  if (choice.type === 'function' && fn && typeof fn.name === 'string') {
    return { type: 'function', name: fn.name };
  }
  return badRequest('Unsupported tool_choice value.');
}

export function chatCompletionsToResponses(body: JsonRecord): JsonRecord {
  if (typeof body.n === 'number' && body.n !== 1) {
    badRequest('Responses only supports one generation; n must be 1.', 'unsupported_parameter');
  }
  const tools = convertTools(body.tools);
  const reasoning =
    typeof body.reasoning_effort === 'string' ? { effort: body.reasoning_effort } : undefined;
  return {
    model: body.model,
    input: convertMessages(body.messages),
    ...(tools ? { tools } : {}),
    ...(body.tool_choice !== undefined ? { tool_choice: convertToolChoice(body.tool_choice) } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(typeof body.max_completion_tokens === 'number'
      ? { max_output_tokens: body.max_completion_tokens }
      : {}),
  };
}

function responseOutput(response: JsonRecord): {
  content: string | null;
  toolCalls: JsonRecord[];
} {
  const text: string[] = [];
  const toolCalls: JsonRecord[] = [];
  const output = Array.isArray(response.output) ? response.output : [];
  for (const rawItem of output) {
    const item = record(rawItem);
    if (!item) continue;
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const rawPart of item.content) {
        const part = record(rawPart);
        if (part?.type === 'output_text' && typeof part.text === 'string') text.push(part.text);
      }
    }
    if (item.type === 'function_call' && typeof item.name === 'string') {
      toolCalls.push({
        id:
          typeof item.call_id === 'string'
            ? item.call_id
            : typeof item.id === 'string'
              ? item.id
              : `call_${toolCalls.length.toString(36)}`,
        type: 'function',
        function: {
          name: item.name,
          arguments: typeof item.arguments === 'string' ? item.arguments : '',
        },
      });
    }
  }
  return { content: text.length > 0 ? text.join('') : null, toolCalls };
}

function unixTime(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1_000);
  }
  return Math.floor(Date.now() / 1_000);
}

function chatUsage(usage: TokenUsage): JsonRecord {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    prompt_tokens_details: { cached_tokens: usage.cachedInputTokens },
  };
}

export function responsesToChatCompletion(payload: unknown): unknown {
  const response = record(payload);
  if (!response) return payload;
  if (response.error) return payload;
  const { content, toolCalls } = responseOutput(response);
  const usage = extractTokenUsage(response);
  const message: JsonRecord = {
    role: 'assistant',
    content,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
  return {
    id: typeof response.id === 'string' ? response.id : 'chatcmpl_router',
    object: 'chat.completion',
    created: unixTime(response.created_at ?? response.created),
    model: typeof response.model === 'string' ? response.model : 'unknown',
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
    usage: chatUsage(usage),
  };
}

function sseData(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

export class ResponsesToChatStreamBridge implements GatewayStreamBridge {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private response: JsonRecord = {};
  private readonly outputItems = new Map<number, JsonRecord>();
  private toolIndexes = new Map<string, number>();
  private nextToolIndex = 0;
  private emittedRole = false;
  private completed: JsonRecord | null = null;
  private currentUsage: TokenUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  private currentErrorCode: string | undefined;
  private outputStarted = false;

  constructor(
    private readonly requestedModel: string,
    private readonly includeUsage: boolean,
  ) {}

  get usage(): TokenUsage {
    return this.currentUsage;
  }

  get completedResponse(): JsonRecord | null {
    return this.completed;
  }

  get errorCode(): string | undefined {
    return this.currentErrorCode;
  }

  get hasOutput(): boolean {
    return this.outputStarted;
  }

  feed(chunk: Uint8Array, final = false): Uint8Array[] {
    this.buffer += this.decoder.decode(chunk, { stream: !final });
    const blocks = this.buffer.split(/\r?\n\r?\n/);
    const tail = blocks.pop() ?? '';
    this.buffer = final ? '' : tail;
    const output: Uint8Array[] = [];
    for (const block of blocks) output.push(...this.consumeBlock(block));
    if (final && tail) output.push(...this.consumeBlock(tail));
    return output;
  }

  private chunk(delta: JsonRecord, finishReason: string | null = null): JsonRecord {
    return {
      id:
        typeof this.response.id === 'string'
          ? this.response.id
          : `chatcmpl_${this.requestedModel.replace(/[^a-zA-Z0-9]/g, '')}`,
      object: 'chat.completion.chunk',
      created: unixTime(this.response.created_at ?? this.response.created),
      model: typeof this.response.model === 'string' ? this.response.model : this.requestedModel,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
    };
  }

  private consumeBlock(block: string): Uint8Array[] {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return [];
    let event: JsonRecord;
    try {
      event = JSON.parse(data) as JsonRecord;
    } catch {
      return [];
    }
    const output: Uint8Array[] = [];
    const response = record(event.response);
    if (response) {
      this.response = { ...this.response, ...response };
      const usage = extractTokenUsage(response);
      if (usage.totalTokens > 0) this.currentUsage = usage;
    }

    if (event.type === 'response.created' && !this.emittedRole) {
      this.emittedRole = true;
      output.push(sseData(this.chunk({ role: 'assistant', content: '' })));
    } else if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      if (event.delta.length > 0) this.outputStarted = true;
      if (!this.emittedRole) {
        this.emittedRole = true;
        output.push(sseData(this.chunk({ role: 'assistant', content: '' })));
      }
      output.push(sseData(this.chunk({ content: event.delta })));
    } else if (event.type === 'response.output_item.added') {
      const item = record(event.item);
      if (item?.type === 'function_call' && typeof item.name === 'string') {
        this.outputStarted = true;
        const itemId = String(item.id ?? item.call_id ?? `tool_${this.nextToolIndex}`);
        const index = this.nextToolIndex++;
        this.toolIndexes.set(itemId, index);
        output.push(
          sseData(
            this.chunk({
              tool_calls: [
                {
                  index,
                  id: String(item.call_id ?? item.id ?? `call_${index}`),
                  type: 'function',
                  function: { name: item.name, arguments: '' },
                },
              ],
            }),
          ),
        );
      }
    } else if (
      event.type === 'response.function_call_arguments.delta' &&
      typeof event.delta === 'string'
    ) {
      if (event.delta.length > 0) this.outputStarted = true;
      const itemId = String(event.item_id ?? '');
      const index = this.toolIndexes.get(itemId) ?? Number(event.output_index ?? 0);
      output.push(
        sseData(this.chunk({ tool_calls: [{ index, function: { arguments: event.delta } }] })),
      );
    } else if (event.type === 'response.output_item.done') {
      const item = record(event.item);
      if (item) this.outputItems.set(Number(event.output_index ?? 0), item);
    } else if (event.type === 'response.completed' && response) {
      const completeResponse =
        (!Array.isArray(response.output) || response.output.length === 0) &&
        this.outputItems.size > 0
          ? {
              ...response,
              output: [...this.outputItems.entries()]
                .sort(([left], [right]) => left - right)
                .map(([, item]) => item),
            }
          : response;
      this.completed = responsesToChatCompletion(completeResponse) as JsonRecord;
      const finishReason =
        responseOutput(completeResponse).toolCalls.length > 0 ? 'tool_calls' : 'stop';
      output.push(sseData(this.chunk({}, finishReason)));
      if (this.includeUsage) {
        const usageChunk = { ...this.chunk({}), choices: [], usage: chatUsage(this.currentUsage) };
        output.push(sseData(usageChunk));
      }
      output.push(new TextEncoder().encode('data: [DONE]\n\n'));
    } else if (event.type === 'error') {
      const error = record(event.error);
      this.currentErrorCode = error?.code === undefined ? 'upstream_error' : String(error.code);
      output.push(sseData({ error: error ?? event }));
      output.push(new TextEncoder().encode('data: [DONE]\n\n'));
    }
    return output;
  }
}
