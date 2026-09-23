/**
 * @created 2026-08-10
 * @description 验证上游定价与费用计算的边界行为。
 * @author yunhungo
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('../db/client', () => ({
  getPool: () => ({ query }),
}));

import { calculateCost, computeCost, computeCostBreakdown, extractTokenUsage } from './usage';

beforeEach(() => {
  query.mockReset();
});

describe('token usage extraction', () => {
  it('supports Responses API usage', () => {
    expect(
      extractTokenUsage({ usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } }),
    ).toEqual({
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 4,
      reasoningTokens: null,
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
      reasoningTokens: null,
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
      reasoningTokens: null,
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
      reasoningTokens: null,
      totalTokens: 10,
    });
  });

  it('extracts reasoning tokens from Responses usage details', () => {
    expect(
      extractTokenUsage({
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 15 },
          total_tokens: 30,
        },
      }),
    ).toEqual({
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 20,
      reasoningTokens: 15,
      totalTokens: 30,
    });
  });

  it('preserves an explicit zero reasoning token count', () => {
    expect(
      extractTokenUsage({
        usage: {
          prompt_tokens: 8,
          completion_tokens: 2,
          output_tokens_details: {},
          completion_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 10,
        },
      }),
    ).toMatchObject({ reasoningTokens: 0 });
  });

  it('prices cached input separately from uncached input', () => {
    expect(
      computeCost(
        {
          inputTokens: 1_000_000,
          cachedInputTokens: 400_000,
          outputTokens: 100_000,
          reasoningTokens: 0,
          totalTokens: 1_100_000,
        },
        { inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 12 },
      ),
    ).toBeCloseTo(2.48);
  });

  it('retains the three charged amounts and rates for the cost tooltip', () => {
    const usage = {
      inputTokens: 1_000_000,
      cachedInputTokens: 400_000,
      outputTokens: 100_000,
      reasoningTokens: 0,
      totalTokens: 1_100_000,
    };
    const price = { inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 12 };
    const breakdown = computeCostBreakdown(usage, price);

    expect(breakdown).toMatchObject({
      inputPerMillionCny: 2,
      cachedInputPerMillionCny: 0.2,
      outputPerMillionCny: 12,
    });
    expect(breakdown.inputCostUsd).toBeCloseTo(1.2 / 6.7, 12);
    expect(breakdown.cachedInputCostUsd).toBeCloseTo(0.08 / 6.7, 12);
    expect(breakdown.outputCostUsd).toBeCloseTo(1.2 / 6.7, 12);
    expect(
      breakdown.inputCostUsd + breakdown.cachedInputCostUsd + breakdown.outputCostUsd,
    ).toBeCloseTo(computeCost(usage, price) / 6.7, 12);
  });

  it('uses the actual upstream connection price, independent of downstream Keys', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          input_per_million: '2',
          cached_input_per_million: '0.2',
          output_per_million: '12',
        },
      ],
      rowCount: 1,
    });

    await expect(
      calculateCost('11111111-1111-4111-8111-111111111111', 'openai', 'gpt-5', {
        inputTokens: 1_000,
        cachedInputTokens: 0,
        outputTokens: 100,
        reasoningTokens: null,
        totalTokens: 1_100,
      }),
    ).resolves.toBeCloseTo(0.0032 / 6.7);

    expect(query.mock.calls[0]?.[0]).toContain('provider_connection_id = $1');
    expect(query.mock.calls[0]?.[0]).not.toContain('virtual_api_key_id');
    expect(query.mock.calls[0]?.[1]).toEqual([
      '11111111-1111-4111-8111-111111111111',
      'openai',
      'gpt-5',
    ]);
  });
});

describe('upstream currency pricing', () => {
  const usage = {
    inputTokens: 3334,
    cachedInputTokens: 3200,
    outputTokens: 298,
    reasoningTokens: 211,
    totalTokens: 3632,
  };
  it('converts official CNY cache and output rates to the USD ledger exactly once', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          currency: 'CNY',
          input_per_million: '1',
          cached_input_per_million: '0.02',
          output_per_million: '4',
        },
      ],
    });
    expect(await calculateCost('connection-a', 'deepseek', 'deepseek-flash', usage)).toBeCloseTo(
      0.00139 / 6.7,
      12,
    );
  });
  it('keeps explicit free rules distinct from missing pricing', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          currency: 'CNY',
          input_per_million: '0',
          cached_input_per_million: '0',
          output_per_million: '0',
        },
      ],
    });
    expect(await calculateCost('connection-a', 'deepseek', 'deepseek-flash', usage)).toBe(0);
    query.mockResolvedValueOnce({ rows: [] });
    expect(
      await calculateCost('connection-b', 'deepseek', 'deepseek-flash', usage),
    ).toBeUndefined();
  });
  it('does not search another connection when no upstream was selected', async () => {
    expect(await calculateCost(undefined, 'deepseek', 'deepseek-flash', usage)).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });
});
