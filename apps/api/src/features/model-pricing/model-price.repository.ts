import type { ModelPriceInput, ModelPriceKeyInput } from '@x-router/contracts';

import { getPool } from '../../db/client';

export interface StoredModelPrice extends ModelPriceInput {
  updatedAt: Date | string;
}

export interface ModelPriceRepository {
  list(): Promise<StoredModelPrice[]>;
  upsert(price: ModelPriceInput): Promise<void>;
  delete(key: ModelPriceKeyInput): Promise<boolean>;
}

export const postgresModelPriceRepository: ModelPriceRepository = {
  async list() {
    const result = await getPool().query<StoredModelPrice>(
      `SELECT provider, model_pattern AS "modelPattern",
              input_per_million::float8 AS "inputPerMillion",
              cached_input_per_million::float8 AS "cachedInputPerMillion",
              output_per_million::float8 AS "outputPerMillion", updated_at AS "updatedAt"
         FROM model_prices ORDER BY provider, model_pattern`,
    );
    return result.rows;
  },

  async upsert(price) {
    await getPool().query(
      `INSERT INTO model_prices(
         provider, model_pattern, input_per_million, cached_input_per_million,
         output_per_million, updated_at
       ) VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (provider, model_pattern) DO UPDATE SET
         input_per_million = EXCLUDED.input_per_million,
         cached_input_per_million = EXCLUDED.cached_input_per_million,
         output_per_million = EXCLUDED.output_per_million,
         updated_at = now()`,
      [
        price.provider,
        price.modelPattern,
        price.inputPerMillion,
        price.cachedInputPerMillion,
        price.outputPerMillion,
      ],
    );
  },

  async delete(key) {
    const result = await getPool().query(
      'DELETE FROM model_prices WHERE provider = $1 AND model_pattern = $2',
      [key.provider, key.modelPattern],
    );
    return Boolean(result.rowCount);
  },
};
