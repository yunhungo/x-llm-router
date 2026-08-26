import type {
  ModelPriceInput,
  ModelPriceKeyInput,
  ModelPriceListResponse,
} from '@x-router/contracts';

import { postgresModelPriceRepository, type ModelPriceRepository } from './model-price.repository';

export class ModelPriceNotFoundError extends Error {
  constructor() {
    super('价格记录不存在。');
    this.name = 'ModelPriceNotFoundError';
  }
}

export class ModelPriceKeyNotFoundError extends Error {
  constructor() {
    super('API Key 不存在。');
    this.name = 'ModelPriceKeyNotFoundError';
  }
}

export class ModelPricingService {
  constructor(private readonly repository: ModelPriceRepository) {}

  private async ensureKeyExists(keyId: string): Promise<void> {
    if (!(await this.repository.keyExists(keyId))) throw new ModelPriceKeyNotFoundError();
  }

  async list(keyId: string): Promise<ModelPriceListResponse> {
    await this.ensureKeyExists(keyId);
    const prices = await this.repository.list(keyId);
    return {
      prices: prices.map((price) => ({
        ...price,
        updatedAt:
          price.updatedAt instanceof Date
            ? price.updatedAt.toISOString()
            : new Date(price.updatedAt).toISOString(),
      })),
    };
  }

  async upsert(keyId: string, price: ModelPriceInput): Promise<void> {
    await this.ensureKeyExists(keyId);
    await this.repository.upsert(keyId, price);
  }

  async delete(keyId: string, key: ModelPriceKeyInput): Promise<void> {
    await this.ensureKeyExists(keyId);
    if (!(await this.repository.delete(keyId, key))) throw new ModelPriceNotFoundError();
  }
}

export const modelPricingService = new ModelPricingService(postgresModelPriceRepository);
