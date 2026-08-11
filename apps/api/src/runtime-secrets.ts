import { randomBytes } from 'node:crypto';

import { z } from 'zod';

import { getPool } from './db/client';

const SETTINGS_KEY = 'runtime_secrets';
const runtimeSecretsSchema = z.object({
  ENCRYPTION_KEY: z.string().min(16),
  JWT_SECRET: z.string().min(16),
});

export type RuntimeSecrets = z.infer<typeof runtimeSecretsSchema>;

interface RuntimeSecretsRow {
  value_json: unknown;
}

let runtimeSecrets: RuntimeSecrets | undefined;

function seedValue(name: keyof RuntimeSecrets, environment: NodeJS.ProcessEnv): string {
  return environment[name]?.trim() || randomBytes(32).toString('hex');
}

async function readStoredSecrets(): Promise<RuntimeSecrets | undefined> {
  const result = await getPool().query<RuntimeSecretsRow>(
    'SELECT value_json FROM platform_settings WHERE key = $1',
    [SETTINGS_KEY],
  );
  const stored = result.rows[0]?.value_json;
  if (stored === undefined) return undefined;
  return runtimeSecretsSchema.parse(typeof stored === 'string' ? JSON.parse(stored) : stored);
}

export async function initializeRuntimeSecrets(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeSecrets> {
  if (runtimeSecrets) return runtimeSecrets;

  const existing = await readStoredSecrets();
  if (existing) {
    runtimeSecrets = existing;
    return runtimeSecrets;
  }

  const seed = runtimeSecretsSchema.parse({
    ENCRYPTION_KEY: seedValue('ENCRYPTION_KEY', environment),
    JWT_SECRET: seedValue('JWT_SECRET', environment),
  });
  await getPool().query(
    `INSERT INTO platform_settings(key, value_json)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO NOTHING`,
    [SETTINGS_KEY, JSON.stringify(seed)],
  );
  runtimeSecrets = await readStoredSecrets();
  if (!runtimeSecrets) throw new Error('Runtime secrets were not persisted.');
  return runtimeSecrets;
}

export function getRuntimeSecrets(): RuntimeSecrets {
  if (!runtimeSecrets) throw new Error('Runtime secrets have not been initialized.');
  return runtimeSecrets;
}

export function setRuntimeSecretsForTests(secrets?: RuntimeSecrets): void {
  runtimeSecrets = secrets ? runtimeSecretsSchema.parse(secrets) : undefined;
}
