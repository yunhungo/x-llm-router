import { describe, expect, it } from 'vitest';

import { clientRequestJavaScript, clientRequestJson } from './request-copy';

describe('usage request copy formats', () => {
  const request = {
    method: 'post',
    url: 'https://example.test/v1/chat/completions',
    headers: { authorization: '[REDACTED]' },
    body: { model: 'gpt-test', stream: true },
  };

  it('copies the complete client request as JSON', () => {
    expect(clientRequestJson(request)).toBe(JSON.stringify(request, null, 2));
  });

  it('builds a JavaScript fetch request with an API token placeholder', () => {
    const javascript = clientRequestJavaScript(request);

    expect(javascript).toContain("const apiToken = '<ROUTER_API_KEY>';");
    expect(javascript).toContain("'Authorization': `Bearer ${apiToken}`");
    expect(javascript).toContain("'Accept': \"text/event-stream\"");
    expect(javascript).toContain('https://example.test/v1/chat/completions');
    expect(javascript).toContain('"model": "gpt-test"');
    expect(javascript).not.toContain('[REDACTED]');
  });
});
