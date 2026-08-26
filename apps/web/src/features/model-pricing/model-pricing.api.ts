import type {
  ModelPriceInput,
  ModelPriceKeyInput,
  ModelPriceListResponse,
} from '@x-router/contracts';

import { api, jsonBody } from '../../api';

const modelPricesPath = (keyId: string) => `/api/admin/keys/${keyId}/model-prices`;

export async function loadModelPrices(keyId: string) {
  return api<ModelPriceListResponse>(modelPricesPath(keyId));
}

export async function upsertModelPrice(keyId: string, price: ModelPriceInput): Promise<void> {
  await api(modelPricesPath(keyId), { method: 'PUT', ...jsonBody(price) });
}

export async function deleteModelPrice(keyId: string, key: ModelPriceKeyInput): Promise<void> {
  await api(modelPricesPath(keyId), { method: 'DELETE', ...jsonBody(key) });
}
