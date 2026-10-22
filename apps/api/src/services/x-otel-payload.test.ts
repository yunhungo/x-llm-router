/**
 * @created 2026-10-22
 * @description 验证长内容截断的字节边界、可辨识标记与普通内容保持。
 * @author yunhungo
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { limitXotelPayload } from './x-otel-payload';

describe('X-Otel content limits', () => {
  it('retains ordinary JSON without changing its representation', () => {
    const value = JSON.stringify({ message: 'hello' });
    expect(limitXotelPayload({ data: value })).toBe(value);
  });

  it('marks oversized content with original bytes and a valid UTF-8 preview range', () => {
    const value = JSON.stringify({ message: '😃'.repeat(20_000) });
    const limited = limitXotelPayload({ data: value });
    if (typeof limited !== 'string') throw new Error('Missing serialized content');
    const marker = z
      .object({
        truncated: z.literal(true),
        reason: z.literal('x_otel_field_limit'),
        original_bytes: z.number(),
        retained_range_bytes: z.tuple([z.literal(0), z.number()]),
        preview: z.string(),
      })
      .parse(JSON.parse(limited));
    expect(marker.original_bytes).toBe(Buffer.byteLength(value));
    expect(marker.preview).not.toContain('\uFFFD');
    expect(Buffer.byteLength(marker.preview)).toBe(marker.retained_range_bytes[1]);
    expect(Buffer.byteLength(limited)).toBeLessThan(12 * 1024);
  });
});
