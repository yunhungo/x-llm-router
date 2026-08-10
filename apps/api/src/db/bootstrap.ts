import { randomUUID } from 'node:crypto';

import bcrypt from 'bcryptjs';

import { getConfig } from '../config';
import { getPool } from './client';

export async function bootstrapInitialAdmin(): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM platform_users',
  );
  if (Number(result.rows[0]?.count ?? 0) > 0) {
    return false;
  }

  const config = getConfig();
  const passwordHash = await bcrypt.hash(config.INITIAL_ADMIN_PASSWORD, 12);
  await pool.query(
    `INSERT INTO platform_users(id, username, password_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (username) DO NOTHING`,
    [randomUUID(), config.INITIAL_ADMIN_USERNAME, passwordHash],
  );
  return true;
}
