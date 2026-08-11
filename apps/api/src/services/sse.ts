import { emptyUsage, extractTokenUsage, type TokenUsage } from './usage';

export class SseAccumulator {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private readonly outputItems = new Map<number, Record<string, unknown>>();
  usage: TokenUsage = emptyUsage();
  completedResponse: Record<string, unknown> | null = null;
  errorCode: string | undefined;
  hasOutput = false;

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
      if (
        (payload.type === 'response.output_text.delta' ||
          payload.type === 'response.function_call_arguments.delta') &&
        typeof payload.delta === 'string' &&
        payload.delta.length > 0
      ) {
        this.hasOutput = true;
      }
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      if (
        choices.some((choice) => {
          if (!choice || typeof choice !== 'object') return false;
          const delta = (choice as Record<string, unknown>).delta;
          if (!delta || typeof delta !== 'object') return false;
          const value = delta as Record<string, unknown>;
          return (
            (typeof value.content === 'string' && value.content.length > 0) ||
            (Array.isArray(value.tool_calls) && value.tool_calls.length > 0)
          );
        })
      ) {
        this.hasOutput = true;
      }
      const nextUsage = extractTokenUsage(payload);
      if (nextUsage.totalTokens > 0) this.usage = nextUsage;
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
}
