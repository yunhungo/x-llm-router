/**
 * @created 2026-08-26
 * @description 维护上游定价、货币换算及用量账本。
 * @author yunhungo
 */
import type { ModelPriceInput, ModelPriceKeyInput } from '@x-router/contracts';

import { getPool } from '../../db/client';

export interface StoredModelPrice extends ModelPriceInput {
  updatedAt: Date | string;
}

export interface ModelPriceRepository {
  connectionExists(connectionId: string): Promise<boolean>;
  list(connectionId: string): Promise<StoredModelPrice[]>;
  upsert(connectionId: string, price: ModelPriceInput): Promise<void>;
  delete(connectionId: string, key: ModelPriceKeyInput): Promise<boolean>;
}

export const postgresModelPriceRepository: ModelPriceRepository = {
  async connectionExists(connectionId) {
    const result = await getPool().query('SELECT id FROM provider_connections WHERE id = $1', [
      connectionId,
    ]);
    return Boolean(result.rowCount);
  },

  async list(connectionId) {
    const result = await getPool().query<StoredModelPrice>(
      `SELECT provider, currency, model_pattern AS "modelPattern",
              input_per_million::float8 AS "inputPerMillion",
              cached_input_per_million::float8 AS "cachedInputPerMillion",
              output_per_million::float8 AS "outputPerMillion", updated_at AS "updatedAt"
         FROM provider_model_prices
        WHERE provider_connection_id = $1
        ORDER BY provider, model_pattern`,
      [connectionId],
    );
    return result.rows;
  },

  async upsert(connectionId, price) {
    await getPool().query(
      `INSERT INTO provider_model_prices(
         provider_connection_id, provider, model_pattern, input_per_million, cached_input_per_million,
         output_per_million, currency, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT (provider_connection_id, provider, model_pattern) DO UPDATE SET
         input_per_million = EXCLUDED.input_per_million,
         cached_input_per_million = EXCLUDED.cached_input_per_million,
         output_per_million = EXCLUDED.output_per_million,
         currency = EXCLUDED.currency,
         updated_at = now()`,
      [
        connectionId,
        price.provider,
        price.modelPattern,
        price.inputPerMillion,
        price.cachedInputPerMillion,
        price.outputPerMillion,
        price.currency,
      ],
    );
  },

  async delete(connectionId, key) {
    const result = await getPool().query(
      `DELETE FROM provider_model_prices
        WHERE provider_connection_id = $1 AND provider = $2 AND model_pattern = $3`,
      [connectionId, key.provider, key.modelPattern],
    );
    return Boolean(result.rowCount);
  },
};
