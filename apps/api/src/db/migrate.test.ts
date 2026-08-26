import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, release, connect } = vi.hoisted(() => {
  const query = vi.fn();
  const release = vi.fn();
  return {
    query,
    release,
    connect: vi.fn(async () => ({ query, release })),
  };
});

vi.mock('./client', () => ({
  getPool: () => ({ connect }),
}));

import { runMigrations } from './migrate';
import { schemaSql, schemaVersion } from './schema';

describe('database migrations', () => {
  beforeEach(() => {
    query.mockReset();
    release.mockReset();
    connect.mockClear();
    query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('does not rerun an already applied migration', async () => {
    query.mockImplementation(async (sql: string) =>
      sql === 'SELECT version FROM schema_migrations'
        ? { rows: [{ version: schemaVersion }], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );

    await runMigrations();

    expect(query).not.toHaveBeenCalledWith(schemaSql);
    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('applies and records a missing migration once', async () => {
    await runMigrations();

    expect(query).toHaveBeenCalledWith(schemaSql);
    expect(query).toHaveBeenCalledWith('INSERT INTO schema_migrations(version) VALUES ($1)', [
      schemaVersion,
    ]);
  });
});
