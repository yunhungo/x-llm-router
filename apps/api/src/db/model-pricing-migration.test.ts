/**
 * @created 2026-09-23
 * @description 验证上游价格迁移隔离及误导入价格修复。
 * @author yunhungo
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { schemaSql } from './schema';

const databaseUrl = process.env.TEST_DATABASE_URL;

it.skipIf(!databaseUrl)(
  'keeps imports scoped and repairs only untouched unrelated legacy prices',
  async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      const schema = `pricing_test_${randomUUID().replaceAll('-', '')}`;
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}`);
      await client.query(schemaSql);
      const connectionId = randomUUID();
      await client.query(
        `INSERT INTO provider_connections
      (id, name, provider, auth_type, credentials_ciphertext, base_url, available_models)
      VALUES ($1, 'DeepSeek', 'deepseek', 'api_key', 'test', 'https://api.deepseek.com',
      '["deepseek-v4-flash"]')`,
        [connectionId],
      );
      await client.query(`INSERT INTO model_prices
      (provider, model_pattern, input_per_million, cached_input_per_million, output_per_million)
      VALUES ('*', 'gpt-5.6', 5, 0.5, 30),
             ('*', 'deepseek-v4', 1, 0.02, 4),
             ('deepseek', 'deepseek-flash', 1, 0.02, 4)`);
      await client.query(schemaSql);
      const imported = await client.query(
        'SELECT model_pattern FROM provider_model_prices ORDER BY model_pattern',
      );
      expect(imported.rows.map((row) => row.model_pattern)).toEqual([
        'deepseek-flash',
        'deepseek-v4',
      ]);

      // Reproduce v16's wildcard import, alongside an explicitly edited rule.
      await client.query('INSERT INTO schema_migrations(version) VALUES (16)');
      await client.query(
        `INSERT INTO provider_model_prices
      (provider_connection_id, provider, model_pattern, input_per_million, cached_input_per_million, output_per_million)
      VALUES ($1, '*', 'gpt-5.6', 33.5, 3.35, 201),
             ($1, '*', 'manually-added', 1, 1, 1),
             ($1, 'deepseek', 'custom-alias', 2, 0.04, 8)`,
        [connectionId],
      );
      const editedConnection = randomUUID();
      await client.query(
        `INSERT INTO provider_connections
      (id, name, provider, auth_type, credentials_ciphertext, base_url)
      VALUES ($1, 'Custom', 'custom', 'api_key', 'test', 'https://example.com')`,
        [editedConnection],
      );
      await client.query(
        `INSERT INTO provider_model_prices
      (provider_connection_id, provider, model_pattern, input_per_million, cached_input_per_million, output_per_million, updated_at)
      VALUES ($1, '*', 'gpt-5.6', 33.5, 3.35, 201, now() + interval '1 second')`,
        [editedConnection],
      );
      await client.query(schemaSql);
      await client.query(schemaSql);
      const repaired = await client.query(
        'SELECT model_pattern FROM provider_model_prices WHERE provider_connection_id = $1 ORDER BY model_pattern',
        [connectionId],
      );
      expect(repaired.rows.map((row) => row.model_pattern)).toEqual([
        'custom-alias',
        'deepseek-flash',
        'deepseek-v4',
        'manually-added',
      ]);
      const edited = await client.query(
        'SELECT model_pattern FROM provider_model_prices WHERE provider_connection_id = $1',
        [editedConnection],
      );
      expect(edited.rows).toEqual([{ model_pattern: 'gpt-5.6' }]);
      expect((await client.query('SELECT * FROM model_prices')).rowCount).toBe(3);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  },
);
