import { getPool } from './client';
import { schemaSql, schemaVersion } from './schema';

export async function runMigrations(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [846_231_771]);
    await client.query(schemaSql);
    await client.query(
      'INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
      [schemaVersion],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
