import type { ModelPriceRule } from '@x-router/contracts';

import type { Provider } from '../../types';

export interface PriceDraft {
  inputPerMillion: string;
  cachedInputPerMillion: string;
  outputPerMillion: string;
}

export interface NewPriceDraft extends PriceDraft {
  provider: string;
  modelPattern: string;
}

export const emptyPriceDraft: NewPriceDraft = {
  provider: '*',
  modelPattern: '',
  inputPerMillion: '',
  cachedInputPerMillion: '',
  outputPerMillion: '',
};

export function priceDraft(price: ModelPriceRule): PriceDraft {
  return {
    inputPerMillion: price.inputPerMillion.toString(),
    cachedInputPerMillion: price.cachedInputPerMillion.toString(),
    outputPerMillion: price.outputPerMillion.toString(),
  };
}

export function priceRuleKey(provider: string, modelPattern: string) {
  return JSON.stringify([provider, modelPattern]);
}

export function priceModelSuggestions(providers: readonly Provider[], provider: string) {
  const models = new Set<string>();
  providers.forEach((connection) => {
    if (provider !== '*' && connection.provider !== provider) return;
    if (connection.defaultModel) models.add(connection.defaultModel);
    connection.models.forEach((model) => models.add(model));
  });
  return [...models].sort((left, right) => left.localeCompare(right));
}

export function parsePriceValues(draft: PriceDraft): [number, number, number] | undefined {
  const rawValues = [draft.inputPerMillion, draft.cachedInputPerMillion, draft.outputPerMillion];
  if (rawValues.some((value) => value.trim() === '')) return undefined;
  const values = rawValues.map(Number) as [number, number, number];
  return values.some((value) => !Number.isFinite(value) || value < 0) ? undefined : values;
}
