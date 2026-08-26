import type {
  ModelPriceInput,
  ModelPriceKeyInput,
  ModelPriceListResponse,
} from '@x-router/contracts';

import { api, jsonBody } from '../../api';
import type { Provider } from '../../types';

const modelPricesPath = '/api/admin/settings/model-prices';

export async function loadModelPricing(): Promise<{
  prices: ModelPriceListResponse['prices'];
  providers: Provider[];
}> {
  const [priceResponse, providerResponse] = await Promise.all([
    api<ModelPriceListResponse>(modelPricesPath),
    api<{ providers: Provider[] }>('/api/admin/providers'),
  ]);
  return {
    prices: priceResponse.prices,
    providers: providerResponse.providers.filter((provider) => provider.status === 'active'),
  };
}

export async function loadModelPrices() {
  return api<ModelPriceListResponse>(modelPricesPath);
}

export async function upsertModelPrice(price: ModelPriceInput): Promise<void> {
  await api(modelPricesPath, { method: 'PUT', ...jsonBody(price) });
}

export async function deleteModelPrice(key: ModelPriceKeyInput): Promise<void> {
  await api(modelPricesPath, { method: 'DELETE', ...jsonBody(key) });
}
