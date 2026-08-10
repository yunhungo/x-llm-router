import { emptyUsage, extractTokenUsage, type TokenUsage } from './usage';

export class SseAccumulator {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  usage: TokenUsage = emptyUsage();
  completedResponse: Record<string, unknown> | null = null;
  errorCode: string | undefined;

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
      const nextUsage = extractTokenUsage(payload);
      if (nextUsage.totalTokens > 0) this.usage = nextUsage;
      if (
        payload.type === 'response.completed' &&
        payload.response &&
        typeof payload.response === 'object'
      ) {
        this.completedResponse = payload.response as Record<string, unknown>;
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
