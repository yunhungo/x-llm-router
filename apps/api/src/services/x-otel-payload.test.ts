/**
 * @created 2026-10-22
 * @description 验证结构保留限长、最近工具上下文、UTF-8 预算和观测目标之间的属性隔离。
 * @author yunhungo
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  limitXotelPayload,
  limitXotelSpanAttributes,
  XOTEL_CONTENT_BYTES,
  XOTEL_METADATA_BYTES,
} from './x-otel-payload';

const markerSchema = z.object({
  xotel_truncated: z.literal(true),
  original_json_bytes: z.number(),
  preview: z.string(),
});

function limit(value: unknown): unknown {
  const result = z.string().parse(limitXotelPayload({ data: JSON.stringify(value) }));
  expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(XOTEL_CONTENT_BYTES);
  return JSON.parse(result);
}

describe('X-Otel content limits', () => {
  it('retains ordinary JSON byte for byte', () => {
    const data = JSON.stringify({ messages: [{ role: 'user', content: '你好 😃' }] });
    expect(limitXotelPayload({ data })).toBe(data);
  });

  it('keeps recent Chat tool IDs and marks long arguments/results and omitted early messages', () => {
    const longValue = '结果😃'.repeat(20_000);
    const messages = [
      ...Array.from({ length: 100 }, (_, index) => ({
        role: 'user',
        content: `${index}:` + 'x'.repeat(1000),
      })),
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_latest',
            type: 'function',
            function: { name: 'lookup', arguments: longValue },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_latest', content: longValue },
    ];
    const result = z
      .object({ messages: z.array(z.record(z.string(), z.unknown())) })
      .parse(limit({ model: 'test', messages }));
    expect(result.messages[0]).toMatchObject({
      type: 'xotel_omitted',
      omitted_items: expect.any(Number),
    });
    const call = z
      .object({
        tool_calls: z.array(
          z.object({
            id: z.string(),
            function: z.object({ name: z.string(), arguments: markerSchema }),
          }),
        ),
      })
      .parse(result.messages.at(-2));
    expect(call.tool_calls[0]?.id).toBe('call_latest');
    expect(call.tool_calls[0]?.function.name).toBe('lookup');
    expect(result.messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_latest',
      content: { xotel_truncated: true },
    });
  });

  it('preserves Responses typed blocks, call IDs and complete short values', () => {
    const input = [
      ...Array.from({ length: 100 }, () => ({ role: 'user', content: 'x'.repeat(2000) })),
      {
        type: 'function_call',
        id: 'fc_keep',
        call_id: 'call_keep',
        name: 'lookup',
        arguments: '{"city":"Shanghai"}',
      },
      { type: 'function_call_output', call_id: 'call_keep', output: '结果'.repeat(40_000) },
    ];
    const result = z
      .object({ input: z.array(z.record(z.string(), z.unknown())) })
      .parse(limit({ input }));
    expect(result.input.at(-2)).toEqual(input.at(-2));
    expect(result.input.at(-1)).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_keep',
      output: { xotel_truncated: true },
    });
    expect(result.input[0]).toMatchObject({
      type: 'xotel_omitted',
      omitted_items: expect.any(Number),
    });
  });

  it('accounts for escaped UTF-8 JSON and bounds pathological nesting without inventing partial JSON', () => {
    const value = '\u0000"\\😃中'.repeat(20_000);
    const marker = markerSchema.parse(limit(value));
    expect(marker.original_json_bytes).toBe(Buffer.byteLength(JSON.stringify(value), 'utf8'));
    expect(marker.preview).not.toContain('\uFFFD');
    expect(marker.preview).toBe(value.slice(0, marker.preview.length));
    expect(Buffer.byteLength(JSON.stringify(marker))).toBeLessThanOrEqual(2048);
    let nested: unknown = { arguments: value };
    for (let index = 0; index < 40; index += 1) nested = { content: nested };
    expect(JSON.stringify(limit(nested))).toContain('"xotel_truncated":true');
  });

  it('caps input/output and aggregate metadata independently without mutating shared span attributes', () => {
    const content = JSON.stringify({
      messages: Array.from({ length: 100 }, () => ({
        role: 'user',
        content: '"\\😃'.repeat(2000),
      })),
    });
    const original: Record<string, string> = {
      'langfuse.observation.input': content,
      'langfuse.observation.output': content,
      'langfuse.trace.metadata.apiKeyId': 'key-keep',
      'langfuse.observation.usage_details': '{"input":100,"output":5}',
      'langfuse.observation.metadata.timeToFirstTokenMs': '125',
      ...Object.fromEntries(
        Array.from({ length: 200 }, (_, index) => [`custom-${index}`, 'y'.repeat(4000)]),
      ),
    };
    const attributes = limitXotelSpanAttributes(original);
    const {
      ['langfuse.observation.input']: input,
      ['langfuse.observation.output']: output,
      ...metadata
    } = attributes;
    expect(Buffer.byteLength(z.string().parse(input))).toBeLessThanOrEqual(XOTEL_CONTENT_BYTES);
    expect(Buffer.byteLength(z.string().parse(output))).toBeLessThanOrEqual(XOTEL_CONTENT_BYTES);
    expect(Buffer.byteLength(JSON.stringify(metadata))).toBeLessThanOrEqual(XOTEL_METADATA_BYTES);
    expect(metadata['langfuse.trace.metadata.apiKeyId']).toBe('key-keep');
    expect(metadata['langfuse.observation.metadata.timeToFirstTokenMs']).toBe('125');
    expect(metadata['langfuse.observation.usage_details']).toBe('{"input":100,"output":5}');
    expect(metadata.xotel_omitted_fields).toBeGreaterThan(0);
    expect(original['langfuse.observation.input']).toBe(content);
    expect(original['custom-0']).toBe('y'.repeat(4000));
    expect(
      Buffer.byteLength(
        JSON.stringify({
          input: JSON.parse(z.string().parse(input)),
          output: JSON.parse(z.string().parse(output)),
          metadata,
        }),
      ),
    ).toBeLessThan(64 * 1024);
  });
});
