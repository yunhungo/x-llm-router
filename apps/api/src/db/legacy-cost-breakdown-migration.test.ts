/**
 * @created 2026-09-23
 * @description 验证旧调用仅在当前价格与原账本总额一致时补齐费用分项。
 * @author yunhungo
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';

import { migrations, schemaSql } from './schema';

const databaseUrl = process.env.TEST_DATABASE_URL;

it.skipIf(!databaseUrl)('reconstructs only ledger-matched historical cost parts', async () => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    const schema = `cost_breakdown_test_${randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}`);
    await client.query(schemaSql);

    const addColumn = migrations.find(({ version }) => version === 18);
    const backfill = migrations.find(({ version }) => version === 19);
    if (!addColumn || !backfill) throw new Error('Cost breakdown migrations are missing.');
    await client.query(addColumn.sql);

    const providerId = randomUUID();
    await client.query(
      `INSERT INTO provider_connections
       (id, name, provider, auth_type, credentials_ciphertext, base_url)
       VALUES ($1, 'DeepSeek', 'deepseek', 'api_key', 'test', 'https://example.com')`,
      [providerId],
    );
    await client.query(
      `INSERT INTO provider_model_prices
       (provider_connection_id, provider, model_pattern, input_per_million,
        cached_input_per_million, output_per_million)
       VALUES ($1, 'deepseek', 'deepseek-flash', 2, 0.04, 8)`,
      [providerId],
    );
    const matchedId = randomUUID();
    const changedPriceId = randomUUID();
    await client.query(
      `INSERT INTO usage_logs
       (id, request_id, provider_connection_id, endpoint, requested_model, model,
        call_status, status_code, success, input_tokens, cached_input_tokens,
        output_tokens, total_tokens, cost_usd)
       VALUES ($1, 'matched', $3, 'chat.completions', 'deepseek-flash', 'deepseek-flash',
               'completed', 200, true, 1593, 1152, 514, 2107, $4),
              ($2, 'changed-price', $3, 'chat.completions', 'deepseek-flash', 'deepseek-flash',
               'completed', 200, true, 1593, 1152, 514, 2107, $5)`,
      [matchedId, changedPriceId, providerId, 0.00504008 / 6.7, 0.009 / 6.7],
    );

    await client.query(backfill.sql);
    const result = await client.query<{
      request_id: string;
      cost_breakdown: {
        inputPerMillionCny: number;
        cachedInputPerMillionCny: number;
        outputPerMillionCny: number;
        inputCostUsd: number;
        cachedInputCostUsd: number;
        outputCostUsd: number;
      } | null;
    }>('SELECT request_id, cost_breakdown FROM usage_logs ORDER BY request_id');
    const matched = result.rows.find((row) => row.request_id === 'matched')?.cost_breakdown;
    const changedPrice = result.rows.find((row) => row.request_id === 'changed-price');

    expect(matched).toMatchObject({
      inputPerMillionCny: 2,
      cachedInputPerMillionCny: 0.04,
      outputPerMillionCny: 8,
    });
    expect(matched?.inputCostUsd).toBeCloseTo(0.000882 / 6.7, 12);
    expect(matched?.cachedInputCostUsd).toBeCloseTo(0.00004608 / 6.7, 12);
    expect(matched?.outputCostUsd).toBeCloseTo(0.004112 / 6.7, 12);
    expect(changedPrice?.cost_breakdown).toBeNull();
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
