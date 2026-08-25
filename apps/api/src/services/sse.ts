import { emptyUsage, extractTokenUsage, type TokenUsage } from './usage';

interface ChatToolCallAccumulator {
  id?: string;
  type?: string;
  name?: string;
  arguments: string;
}

interface ChatChoiceAccumulator {
  role: string;
  content: string;
  reasoning: string;
  reasoningContent: string;
  reasoningDetails: unknown[];
  toolCalls: Map<number, ChatToolCallAccumulator>;
  finishReason: unknown;
  nativeFinishReason: unknown;
  logprobs: unknown;
}

export class SseAccumulator {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private readonly outputItems = new Map<number, Record<string, unknown>>();
  private readonly chatChoices = new Map<number, ChatChoiceAccumulator>();
  private chatCompletionMetadata: Record<string, unknown> = {};
  usage: TokenUsage = emptyUsage();
  completedResponse: Record<string, unknown> | null = null;
  errorCode: string | undefined;
  hasGeneratedOutput = false;
  hasVisibleOutput = false;

  feed(chunk: Uint8Array, final = false): void {
    this.buffer += this.decoder.decode(chunk, { stream: !final });
    const blocks = this.buffer.split(/\r?\n\r?\n/);
    const tail = blocks.pop() ?? '';
    this.buffer = final ? '' : tail;
    for (const block of blocks) this.consumeBlock(block);
    if (final && tail) this.consumeBlock(tail);
  }

  private consumeBlock(block: string): void {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    try {
      const payload = JSON.parse(data) as Record<string, unknown>;
      const hasVisibleResponsesDelta =
        (payload.type === 'response.output_text.delta' ||
          payload.type === 'response.function_call_arguments.delta') &&
        typeof payload.delta === 'string' &&
        payload.delta.length > 0;
      const hasReasoningResponsesDelta =
        (payload.type === 'response.reasoning_text.delta' ||
          payload.type === 'response.reasoning_summary_text.delta') &&
        typeof payload.delta === 'string' &&
        payload.delta.length > 0;
      if (hasVisibleResponsesDelta) this.hasVisibleOutput = true;
      if (hasVisibleResponsesDelta || hasReasoningResponsesDelta) {
        this.hasGeneratedOutput = true;
      }
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      const hasVisibleChoice = choices.some((choice) => {
        if (!choice || typeof choice !== 'object') return false;
        const delta = (choice as Record<string, unknown>).delta;
        if (!delta || typeof delta !== 'object') return false;
        const value = delta as Record<string, unknown>;
        return (
          (typeof value.content === 'string' && value.content.length > 0) ||
          (Array.isArray(value.tool_calls) && value.tool_calls.length > 0)
        );
      });
      const hasReasoningChoice = choices.some((choice) => {
        if (!choice || typeof choice !== 'object') return false;
        const delta = (choice as Record<string, unknown>).delta;
        if (!delta || typeof delta !== 'object') return false;
        const value = delta as Record<string, unknown>;
        return (
          (typeof value.reasoning === 'string' && value.reasoning.length > 0) ||
          (typeof value.reasoning_content === 'string' && value.reasoning_content.length > 0) ||
          (Array.isArray(value.reasoning_details) && value.reasoning_details.length > 0)
        );
      });
      if (hasVisibleChoice) this.hasVisibleOutput = true;
      if (hasVisibleChoice || hasReasoningChoice) this.hasGeneratedOutput = true;
      const nextUsage = extractTokenUsage(payload);
      if (nextUsage.totalTokens > 0) this.usage = nextUsage;
      this.accumulateChatCompletion(payload);
      if (
        payload.type === 'response.output_item.done' &&
        typeof payload.output_index === 'number' &&
        payload.item &&
        typeof payload.item === 'object'
      ) {
        this.outputItems.set(payload.output_index, payload.item as Record<string, unknown>);
      }
      if (
        payload.type === 'response.completed' &&
        payload.response &&
        typeof payload.response === 'object'
      ) {
        const response = payload.response as Record<string, unknown>;
        this.completedResponse =
          (!Array.isArray(response.output) || response.output.length === 0) &&
          this.outputItems.size > 0
            ? {
                ...response,
                output: [...this.outputItems.entries()]
                  .sort(([left], [right]) => left - right)
                  .map(([, item]) => item),
              }
            : response;
      }
      if (payload.type === 'error') {
        const error = payload.error;
        if (error && typeof error === 'object' && 'code' in error) {
          this.errorCode = String((error as { code: unknown }).code);
        }
      }
    } catch {
      // Ignore non-JSON keepalive frames while preserving the original stream for the client.
    }
  }

  private accumulateChatCompletion(payload: Record<string, unknown>): void {
    const choices = Array.isArray(payload.choices) ? payload.choices : [];

    for (const key of ['id', 'created', 'model', 'system_fingerprint', 'provider'] as const) {
      if (payload[key] !== undefined) this.chatCompletionMetadata[key] = payload[key];
    }
    if (payload.usage && typeof payload.usage === 'object') {
      this.chatCompletionMetadata.usage = payload.usage;
    }
    if (choices.length === 0 && this.chatChoices.size === 0) return;

    for (const [position, rawChoice] of choices.entries()) {
      if (!rawChoice || typeof rawChoice !== 'object') continue;
      const choice = rawChoice as Record<string, unknown>;
      const index = typeof choice.index === 'number' ? choice.index : position;
      const accumulated = this.chatChoices.get(index) ?? {
        role: 'assistant',
        content: '',
        reasoning: '',
        reasoningContent: '',
        reasoningDetails: [],
        toolCalls: new Map<number, ChatToolCallAccumulator>(),
        finishReason: null,
        nativeFinishReason: null,
        logprobs: null,
      };
      const delta =
        choice.delta && typeof choice.delta === 'object'
          ? (choice.delta as Record<string, unknown>)
          : {};

      if (typeof delta.role === 'string') accumulated.role = delta.role;
      if (typeof delta.content === 'string') accumulated.content += delta.content;
      if (typeof delta.reasoning === 'string') accumulated.reasoning += delta.reasoning;
      if (typeof delta.reasoning_content === 'string') {
        accumulated.reasoningContent += delta.reasoning_content;
      }
      if (Array.isArray(delta.reasoning_details)) {
        accumulated.reasoningDetails.push(...delta.reasoning_details);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const [toolPosition, rawToolCall] of delta.tool_calls.entries()) {
          if (!rawToolCall || typeof rawToolCall !== 'object') continue;
          const toolCall = rawToolCall as Record<string, unknown>;
          const toolIndex = typeof toolCall.index === 'number' ? toolCall.index : toolPosition;
          const existing = accumulated.toolCalls.get(toolIndex) ?? { arguments: '' };
          const fn =
            toolCall.function && typeof toolCall.function === 'object'
              ? (toolCall.function as Record<string, unknown>)
              : {};
          if (typeof toolCall.id === 'string') existing.id = toolCall.id;
          if (typeof toolCall.type === 'string') existing.type = toolCall.type;
          if (typeof fn.name === 'string') existing.name = fn.name;
          if (typeof fn.arguments === 'string') existing.arguments += fn.arguments;
          accumulated.toolCalls.set(toolIndex, existing);
        }
      }
      if (choice.finish_reason !== undefined) accumulated.finishReason = choice.finish_reason;
      if (choice.native_finish_reason !== undefined) {
        accumulated.nativeFinishReason = choice.native_finish_reason;
      }
      if (choice.logprobs !== undefined) accumulated.logprobs = choice.logprobs;
      this.chatChoices.set(index, accumulated);
    }

    this.completedResponse = {
      ...this.chatCompletionMetadata,
      object: 'chat.completion',
      choices: [...this.chatChoices.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, choice]) => {
          const toolCalls = [...choice.toolCalls.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, toolCall]) => ({
              ...(toolCall.id ? { id: toolCall.id } : {}),
              type: toolCall.type ?? 'function',
              function: {
                ...(toolCall.name ? { name: toolCall.name } : {}),
                arguments: toolCall.arguments,
              },
            }));
          return {
            index,
            message: {
              role: choice.role,
              content: choice.content || null,
              ...(choice.reasoning ? { reasoning: choice.reasoning } : {}),
              ...(choice.reasoningContent ? { reasoning_content: choice.reasoningContent } : {}),
              ...(choice.reasoningDetails.length > 0
                ? { reasoning_details: choice.reasoningDetails }
                : {}),
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: choice.finishReason,
            ...(choice.nativeFinishReason !== null
              ? { native_finish_reason: choice.nativeFinishReason }
              : {}),
            logprobs: choice.logprobs,
          };
        }),
    };
  }
}

export function mergeStoredSseSnapshot(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const snapshot = value as Record<string, unknown>;
  if (snapshot.stream !== true || snapshot.truncated === true || !Array.isArray(snapshot.events)) {
    return value;
  }

  const accumulator = new SseAccumulator();
  const encoder = new TextEncoder();
  for (const event of snapshot.events) {
    accumulator.feed(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  }
  accumulator.feed(new Uint8Array(), true);
  return accumulator.completedResponse ?? value;
}
