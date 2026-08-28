import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { UsageLogTokenSummary } from '.';

describe('UsageLogTokenSummary', () => {
  it('renders the compact two-line token breakdown', () => {
    const markup = renderToStaticMarkup(
      <UsageLogTokenSummary
        totalTokens={222}
        inputTokens={100}
        outputTokens={122}
        cachedInputTokens={3_000}
        reasoningTokens={50}
      />,
    );

    expect(markup).toContain('<strong>222</strong>');
    expect(markup).toContain('(in 100,out 122)');
    expect(markup).toContain('reasoning 50, in cache 3,000');
  });

  it('omits an unavailable reasoning count without hiding cache usage', () => {
    const markup = renderToStaticMarkup(
      <UsageLogTokenSummary
        totalTokens={10}
        inputTokens={6}
        outputTokens={4}
        cachedInputTokens={3}
        reasoningTokens={null}
      />,
    );

    expect(markup).not.toContain('reasoning');
    expect(markup).toContain('in cache 3');
  });
});
