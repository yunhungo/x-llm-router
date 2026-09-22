/**
 * @created 2026-08-26
 * @description 负责上游模型价格规则的维护与计费。
 * @author yunhungo
 */
import type {
  ModelPriceInput,
  ModelPriceKeyInput,
  ModelPriceListResponse,
} from '@x-router/contracts';

import { api, jsonBody } from '../../api';

const modelPricesPath = (connectionId: string) =>
  `/api/admin/providers/${connectionId}/model-prices`;

export async function loadModelPrices(connectionId: string) {
  return api<ModelPriceListResponse>(modelPricesPath(connectionId));
}

export async function upsertModelPrice(
  connectionId: string,
  price: ModelPriceInput,
): Promise<void> {
  await api(modelPricesPath(connectionId), { method: 'PUT', ...jsonBody(price) });
}

export async function deleteModelPrice(
  connectionId: string,
  key: ModelPriceKeyInput,
): Promise<void> {
  await api(modelPricesPath(connectionId), { method: 'DELETE', ...jsonBody(key) });
}
