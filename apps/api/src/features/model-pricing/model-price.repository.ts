import type { ModelPriceInput, ModelPriceKeyInput } from '@x-router/contracts';

import { getPool } from '../../db/client';

export interface StoredModelPrice extends ModelPriceInput {
  updatedAt: Date | string;
}

export interface ModelPriceRepository {
  keyExists(keyId: string): Promise<boolean>;
  list(keyId: string): Promise<StoredModelPrice[]>;
  upsert(keyId: string, price: ModelPriceInput): Promise<void>;
  delete(keyId: string, key: ModelPriceKeyInput): Promise<boolean>;
}

export const postgresModelPriceRepository: ModelPriceRepository = {
  async keyExists(keyId) {
    const result = await getPool().query('SELECT id FROM virtual_api_keys WHERE id = $1', [keyId]);
    return Boolean(result.rowCount);
  },

  async list(keyId) {
    const result = await getPool().query<StoredModelPrice>(
      `SELECT provider, model_pattern AS "modelPattern",
              input_per_million::float8 AS "inputPerMillion",
              cached_input_per_million::float8 AS "cachedInputPerMillion",
              output_per_million::float8 AS "outputPerMillion", updated_at AS "updatedAt"
         FROM model_prices
        WHERE virtual_api_key_id = $1
        ORDER BY provider, model_pattern`,
      [keyId],
    );
    return result.rows;
  },

  async upsert(keyId, price) {
    await getPool().query(
      `INSERT INTO model_prices(
         virtual_api_key_id, provider, model_pattern, input_per_million, cached_input_per_million,
         output_per_million, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT (virtual_api_key_id, provider, model_pattern) DO UPDATE SET
         input_per_million = EXCLUDED.input_per_million,
         cached_input_per_million = EXCLUDED.cached_input_per_million,
         output_per_million = EXCLUDED.output_per_million,
         updated_at = now()`,
      [
        keyId,
        price.provider,
        price.modelPattern,
        price.inputPerMillion,
        price.cachedInputPerMillion,
        price.outputPerMillion,
      ],
    );
  },

  async delete(keyId, key) {
    const result = await getPool().query(
      `DELETE FROM model_prices
        WHERE virtual_api_key_id = $1 AND provider = $2 AND model_pattern = $3`,
      [keyId, key.provider, key.modelPattern],
    );
    return Boolean(result.rowCount);
  },
};
