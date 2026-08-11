import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('./db/client', () => ({
  getPool: () => ({ query: mocks.query }),
}));

import {
  getRuntimeSecrets,
  initializeRuntimeSecrets,
  setRuntimeSecretsForTests,
  type RuntimeSecrets,
} from './runtime-secrets';

describe('database-backed runtime secrets', () => {
  let stored: RuntimeSecrets | undefined;

  beforeEach(() => {
    stored = undefined;
    mocks.query.mockReset();
    mocks.query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('INSERT INTO platform_settings')) {
        stored ??= JSON.parse(String(values?.[1])) as RuntimeSecrets;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT value_json FROM platform_settings')) {
        return {
          rows: stored ? [{ value_json: stored }] : [],
          rowCount: stored ? 1 : 0,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    setRuntimeSecretsForTests();
  });

  it('generates and persists missing secrets', async () => {
    const secrets = await initializeRuntimeSecrets({});

    expect(secrets.ENCRYPTION_KEY).toMatch(/^[a-f0-9]{64}$/u);
    expect(secrets.JWT_SECRET).toMatch(/^[a-f0-9]{64}$/u);
    expect(secrets.JWT_SECRET).not.toBe(secrets.ENCRYPTION_KEY);
    expect(stored).toEqual(secrets);
    expect(getRuntimeSecrets()).toEqual(secrets);
  });

  it('reuses the database values after a process restart', async () => {
    stored = {
      ENCRYPTION_KEY: 'database-encryption-key-value',
      JWT_SECRET: 'database-jwt-secret-value',
    };

    const first = await initializeRuntimeSecrets({
      ENCRYPTION_KEY: 'short',
      JWT_SECRET: 'short',
    });
    setRuntimeSecretsForTests();
    const second = await initializeRuntimeSecrets({});

    expect(first).toEqual(stored);
    expect(second).toEqual(stored);
  });

  it('uses legacy environment values only when creating the database row', async () => {
    const legacy = {
      ENCRYPTION_KEY: 'legacy-encryption-key-with-enough-length',
      JWT_SECRET: 'legacy-jwt-secret-with-enough-length',
    };

    await expect(initializeRuntimeSecrets(legacy)).resolves.toEqual(legacy);
    expect(stored).toEqual(legacy);
  });

  it('refuses to silently replace invalid persisted values', async () => {
    stored = {
      ENCRYPTION_KEY: 'short',
      JWT_SECRET: 'database-jwt-secret-value',
    };

    await expect(initializeRuntimeSecrets({})).rejects.toThrow('ENCRYPTION_KEY');
    expect(stored.ENCRYPTION_KEY).toBe('short');
  });

  it('fails clearly when accessed before startup initialization', () => {
    expect(() => getRuntimeSecrets()).toThrow('have not been initialized');
  });
});
