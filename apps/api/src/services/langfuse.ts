import { LangfuseSpanProcessor } from '@langfuse/otel';
import { NodeSDK } from '@opentelemetry/sdk-node';

import { getConfig } from '../config';
import { getPool } from '../db/client';
import { decryptJson, encryptJson } from '../lib/crypto';

export interface LangfuseRuntimeSettings {
  enabled: boolean;
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  environment: string;
  captureInput: boolean;
  captureOutput: boolean;
}

interface LangfuseSettingsRow {
  value_json: {
    enabled?: boolean;
    publicKey?: string;
    baseUrl?: string;
    environment?: string;
    captureInput?: boolean;
    captureOutput?: boolean;
  };
  secret_ciphertext: string | null;
}

let runtimeSettings: LangfuseRuntimeSettings | undefined;
let telemetrySdk: NodeSDK | undefined;

export async function loadLangfuseSettings(): Promise<LangfuseRuntimeSettings> {
  const config = getConfig();
  const result = await getPool().query<LangfuseSettingsRow>(
    `SELECT value_json, secret_ciphertext FROM platform_settings WHERE key = 'langfuse'`,
  );
  const row = result.rows[0];
  const saved = row?.value_json ?? {};
  let secretKey = config.LANGFUSE_SECRET_KEY ?? '';
  if (row?.secret_ciphertext) {
    secretKey = decryptJson<{ secretKey: string }>(row.secret_ciphertext).secretKey;
  }
  runtimeSettings = {
    enabled: saved.enabled ?? config.LANGFUSE_ENABLED,
    publicKey: saved.publicKey ?? config.LANGFUSE_PUBLIC_KEY ?? '',
    secretKey,
    baseUrl: saved.baseUrl ?? config.LANGFUSE_BASE_URL,
    environment: saved.environment ?? config.LANGFUSE_TRACING_ENVIRONMENT,
    captureInput: saved.captureInput ?? false,
    captureOutput: saved.captureOutput ?? false,
  };
  return runtimeSettings;
}

export function currentLangfuseSettings(): LangfuseRuntimeSettings {
  if (!runtimeSettings) {
    throw new Error('Langfuse settings have not been loaded.');
  }
  return runtimeSettings;
}

export async function initializeLangfuse(): Promise<boolean> {
  const settings = await loadLangfuseSettings();
  if (!settings.enabled || !settings.publicKey || !settings.secretKey) return false;

  process.env.LANGFUSE_TRACING_ENVIRONMENT = settings.environment;
  telemetrySdk = new NodeSDK({
    spanProcessors: [
      new LangfuseSpanProcessor({
        publicKey: settings.publicKey,
        secretKey: settings.secretKey,
        baseUrl: settings.baseUrl,
      }),
    ],
  });
  telemetrySdk.start();
  return true;
}

export async function shutdownLangfuse(): Promise<void> {
  if (telemetrySdk) await telemetrySdk.shutdown();
}

export async function saveLangfuseSettings(
  input: Omit<LangfuseRuntimeSettings, 'secretKey'> & { secretKey?: string },
  updatedBy: string,
): Promise<void> {
  const existing = await loadLangfuseSettings();
  const secretKey = input.secretKey || existing.secretKey;
  await getPool().query(
    `INSERT INTO platform_settings(key, value_json, secret_ciphertext, updated_by, updated_at)
     VALUES ('langfuse', $1::jsonb, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET
       value_json = EXCLUDED.value_json,
       secret_ciphertext = EXCLUDED.secret_ciphertext,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()`,
    [
      JSON.stringify({
        enabled: input.enabled,
        publicKey: input.publicKey,
        baseUrl: input.baseUrl,
        environment: input.environment,
        captureInput: input.captureInput,
        captureOutput: input.captureOutput,
      }),
      secretKey ? encryptJson({ secretKey }) : null,
      updatedBy,
    ],
  );
  runtimeSettings = { ...input, secretKey };
}

export function publicLangfuseSettings(
  settings = currentLangfuseSettings(),
): Record<string, unknown> {
  return {
    enabled: settings.enabled,
    publicKey: settings.publicKey,
    hasSecretKey: Boolean(settings.secretKey),
    baseUrl: settings.baseUrl,
    environment: settings.environment,
    captureInput: settings.captureInput,
    captureOutput: settings.captureOutput,
    restartRequiredAfterSave: true,
  };
}
