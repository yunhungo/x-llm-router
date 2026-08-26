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

export class ModelPricingService {
  constructor(private readonly repository: ModelPriceRepository) {}

  async list(): Promise<ModelPriceListResponse> {
    const prices = await this.repository.list();
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

  async upsert(price: ModelPriceInput): Promise<void> {
    await this.repository.upsert(price);
  }

  async delete(key: ModelPriceKeyInput): Promise<void> {
    if (!(await this.repository.delete(key))) throw new ModelPriceNotFoundError();
  }
}

export const modelPricingService = new ModelPricingService(postgresModelPriceRepository);
