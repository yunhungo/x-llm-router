import { describe, expect, it } from 'vitest';

import { computeCost, extractTokenUsage } from './usage';

describe('token usage extraction', () => {
  it('supports Responses API usage', () => {
    expect(
      extractTokenUsage({ usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } }),
    ).toEqual({
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 4,
      totalTokens: 14,
    });
  });

  it('supports Chat Completions usage', () => {
    expect(
      extractTokenUsage({ usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }),
    ).toEqual({
      inputTokens: 8,
      cachedInputTokens: 0,
      outputTokens: 2,
      totalTokens: 10,
    });
  });

  it('supports top-level cache-hit usage from compatible APIs', () => {
    expect(
      extractTokenUsage({
        usage: {
          prompt_tokens: 12,
          prompt_cache_hit_tokens: 7,
          completion_tokens: 3,
          total_tokens: 15,
        },
      }),
    ).toEqual({
      inputTokens: 12,
      cachedInputTokens: 7,
      outputTokens: 3,
      totalTokens: 15,
    });
  });

  it('supports response.completed SSE payloads', () => {
    expect(
      extractTokenUsage({ response: { usage: { input_tokens: 7, output_tokens: 3 } } }),
    ).toEqual({
      inputTokens: 7,
      cachedInputTokens: 0,
      outputTokens: 3,
      totalTokens: 10,
    });
  });

  it('prices cached input separately from uncached input', () => {
    expect(
      computeCost(
        {
          inputTokens: 1_000_000,
          cachedInputTokens: 400_000,
          outputTokens: 100_000,
          totalTokens: 1_100_000,
        },
        { inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 12 },
      ),
    ).toBeCloseTo(2.48);
  });
});
