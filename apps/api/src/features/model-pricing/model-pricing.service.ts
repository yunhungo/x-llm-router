/**
 * @created 2026-08-26
 * @description 维护上游定价、货币换算及用量账本。
 * @author yunhungo
 */
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

export class ModelPriceConnectionNotFoundError extends Error {
  constructor() {
    super('上游连接 不存在。');
    this.name = 'ModelPriceConnectionNotFoundError';
  }
}

export class ModelPricingService {
  constructor(private readonly repository: ModelPriceRepository) {}

  private async ensureConnectionExists(connectionId: string): Promise<void> {
    if (!(await this.repository.connectionExists(connectionId)))
      throw new ModelPriceConnectionNotFoundError();
  }

  async list(connectionId: string): Promise<ModelPriceListResponse> {
    await this.ensureConnectionExists(connectionId);
    const prices = await this.repository.list(connectionId);
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

  async upsert(connectionId: string, price: ModelPriceInput): Promise<void> {
    await this.ensureConnectionExists(connectionId);
    await this.repository.upsert(connectionId, price);
  }

  async delete(connectionId: string, key: ModelPriceKeyInput): Promise<void> {
    await this.ensureConnectionExists(connectionId);
    if (!(await this.repository.delete(connectionId, key))) throw new ModelPriceNotFoundError();
  }
}

export const modelPricingService = new ModelPricingService(postgresModelPriceRepository);
