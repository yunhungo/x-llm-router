import { describe, expect, it } from 'vitest';

import { buildCurl, prepareStoredJson, redactSensitive, SseDetailCollector } from './usage-details';

describe('usage detail storage', () => {
  it('redacts credentials without hiding token counters', () => {
    expect(
      redactSensitive({
        authorization: 'Bearer secret',
        'x-client-secret': 'also secret',
        nested: { api_key: 'sk-secret', max_tokens: 1024, input_tokens: 12 },
      }),
    ).toEqual({
      authorization: '[REDACTED]',
      'x-client-secret': '[REDACTED]',
      nested: { api_key: '[REDACTED]', max_tokens: 1024, input_tokens: 12 },
    });
  });

  it('caps oversized payloads', () => {
    expect(prepareStoredJson({ output: 'x'.repeat(1_000) }, 200)).toMatchObject({
      _truncated: true,
    });
  });

  it('builds reproducible curl with placeholder credentials', () => {
    const curl = buildCurl({
      url: 'https://example.test/v1/responses',
      body: { model: 'gpt-test', input: "what's new" },
      authorization: '<ROUTER_API_KEY>',
    });
    expect(curl).toContain('Authorization: Bearer <ROUTER_API_KEY>');
    expect(curl).toContain('gpt-test');
    expect(curl).not.toContain('sk-secret');
  });

  it('stores the completed Responses payload from SSE', () => {
    const collector = new SseDetailCollector();
    collector.feed(
      new TextEncoder().encode(
        'data: {"type":"response.completed","response":{"id":"resp_1","output":[]}}\n\n',
      ),
      true,
    );
    expect(collector.snapshot()).toEqual({ id: 'resp_1', output: [] });
  });
});
