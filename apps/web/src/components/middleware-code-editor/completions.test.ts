import { describe, expect, it } from 'vitest';

import { middlewareCompletionOptions } from './completions';

describe('middleware editor completions', () => {
  const byLabel = new Map(middlewareCompletionOptions.map((option) => [option.label, option]));

  it('describes safe API key and provider metadata', () => {
    expect(byLabel.get('ctx.key.provider.slug')?.detail).toBe('string');
    expect(byLabel.get('ctx.key.provider.authType')?.detail).toContain('oauth');
    expect(byLabel.get('ctx.key.rpmLimit')?.detail).toBe('number');
    expect(byLabel.has('ctx.key.provider.apiKey')).toBe(false);
  });

  it('offers endpoint-aware request and response body fields', () => {
    expect(byLabel.get('ctx.request.body')?.detail).toContain('ResponsesRequestBody');
    expect(byLabel.get('ctx.request.body.input')?.info).toContain('Responses');
    expect(byLabel.get('ctx.request.body.messages')?.info).toContain('Chat Completions');
    expect(byLabel.get('ctx.response.body.choices')?.detail).toContain('ChatCompletionChoice');
  });

  it('covers every top-level middleware context area', () => {
    for (const label of [
      'ctx.request',
      'ctx.response',
      'ctx.key',
      'ctx.endpoint',
      'ctx.requestId',
      'ctx.state',
      'ctx.crypto.sha256',
      'ctx.base64.encode',
      'ctx.url.parse',
      'ctx.modules.crypto',
      'ctx.log.info',
    ]) {
      expect(byLabel.has(label), label).toBe(true);
    }
  });
});
