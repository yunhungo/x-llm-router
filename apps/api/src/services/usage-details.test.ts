import { describe, expect, it } from 'vitest';

import {
  buildCurl,
  buildStoredRequestCurl,
  prepareStoredJson,
  prepareStoredRequest,
  redactSensitive,
  SseDetailCollector,
} from './usage-details';

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

  it('redacts credential-like headers without hiding body token parameters', () => {
    expect(
      prepareStoredRequest({
        headers: {
          'x-auth-token': 'auth-secret',
          'x-amz-security-token': 'aws-secret',
          'x-webhook-signature': 'signature-secret',
          'x-feature': 'visible',
        },
        body: { max_tokens: 1024 },
      }),
    ).toEqual({
      headers: {
        'x-auth-token': '[REDACTED]',
        'x-amz-security-token': '[REDACTED]',
        'x-webhook-signature': '[REDACTED]',
        'x-feature': 'visible',
      },
      body: { max_tokens: 1024 },
    });
  });

  it('builds reproducible curl with placeholder credentials', () => {
    const curl = buildCurl({
      url: 'https://example.test/v1/responses',
      body: { model: 'gpt-test', input: "what's new" },
      authorization: '<ROUTER_API_KEY>',
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-secret',
        'content-type': 'application/json',
        'x-client-trace': 'trace-123',
        'x-api-key': 'another-secret',
        'Content-Length': '999999',
        'content-encoding': 'gzip',
      },
    });
    expect(curl).toContain("curl -X 'POST'");
    expect(curl).toContain('Authorization: Bearer <ROUTER_API_KEY>');
    expect(curl).toContain('x-client-trace: trace-123');
    expect(curl).toContain('x-api-key: [REDACTED]');
    expect(curl).toContain('gpt-test');
    expect(curl).not.toContain('sk-secret');
    expect(curl).not.toContain('another-secret');
    expect(curl).not.toContain('content-length');
    expect(curl).not.toContain('999999');
    expect(curl).not.toContain('content-encoding');
  });

  it('keeps repeated headers and uses the effective request ID', () => {
    const curl = buildCurl({
      url: 'https://example.test/v1/chat/completions',
      body: { model: 'gpt-test' },
      authorization: '<ROUTER_API_KEY>',
      headers: {
        accept: 'application/json',
        'x-tag': ['one', 'two'],
        'x-request-id': 'client-request-id',
      },
      requestId: 'effective-request-id',
    });

    expect(curl).toContain('Accept: application/json');
    expect(curl).toContain('x-tag: one');
    expect(curl).toContain('x-tag: two');
    expect(curl).toContain('X-Request-Id: effective-request-id');
    expect(curl).not.toContain('client-request-id');
  });

  it('rebuilds historical curl from the stored request snapshot', () => {
    const curl = buildStoredRequestCurl(
      prepareStoredJson({
        method: 'POST',
        url: 'https://example.test/v1/responses',
        headers: {
          authorization: 'Bearer sk-secret',
          'x-added-later': 'visible-in-detail',
        },
        body: { model: 'gpt-test', input: 'hello' },
      }),
      '<ROUTER_API_KEY>',
      'request-123',
    );

    expect(curl).toContain('x-added-later: visible-in-detail');
    expect(curl).toContain('Authorization: Bearer <ROUTER_API_KEY>');
    expect(curl).toContain('X-Request-Id: request-123');
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
