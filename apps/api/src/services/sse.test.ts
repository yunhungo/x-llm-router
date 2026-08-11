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

  it('marks output only after a semantic token rather than any SSE frame', () => {
    const parser = new SseAccumulator();
    parser.feed(Buffer.from('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n'));
    expect(parser.hasOutput).toBe(false);

    parser.feed(Buffer.from('data: {"type":"response.output_text.delta","delta":"Hi"}\n\n'));
    expect(parser.hasOutput).toBe(true);
  });
});
