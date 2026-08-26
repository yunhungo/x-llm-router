import { describe, expect, it } from 'vitest';

import { parsePriceValues, priceModelSuggestions } from './model-pricing.model';

describe('model pricing model', () => {
  it('offers unique synced models for the selected provider', () => {
    const providers = [
      {
        provider: 'openai',
        defaultModel: 'gpt-default',
        models: ['gpt-default', 'gpt-mini'],
      },
      {
        provider: 'deepseek',
        defaultModel: null,
        models: ['deepseek-chat'],
      },
    ] as never;

    expect(priceModelSuggestions(providers, 'openai')).toEqual(['gpt-default', 'gpt-mini']);
    expect(priceModelSuggestions(providers, '*')).toEqual([
      'deepseek-chat',
      'gpt-default',
      'gpt-mini',
    ]);
  });

  it('accepts complete non-negative price values', () => {
    expect(
      parsePriceValues({
        inputPerMillion: '5',
        cachedInputPerMillion: '0.5',
        outputPerMillion: '30',
      }),
    ).toEqual([5, 0.5, 30]);
    expect(
      parsePriceValues({
        inputPerMillion: '',
        cachedInputPerMillion: '0.5',
        outputPerMillion: '30',
      }),
    ).toBeUndefined();
  });
});
