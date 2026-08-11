import { LangfuseSpanProcessor } from '@langfuse/otel';
import { NodeSDK } from '@opentelemetry/sdk-node';

import { getPool } from '../db/client';
import { decryptJson, encryptJson } from '../lib/crypto';

export interface KeyLangfuseSettings {
  enabled: boolean;
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  environment: string;
  traceName: string;
  version: string;
  tags: string[];
  metadata: Record<string, string>;
  userIdHeader: string;
  sessionIdHeader: string;
  captureInput: boolean;
  captureOutput: boolean;
}

interface LangfuseKeyRow {
  id: string;
  langfuse_config_ciphertext: string | null;
}

const API_KEY_ATTRIBUTE = 'langfuse.trace.metadata.apiKeyId';

let telemetrySdk: NodeSDK | undefined;

export function defaultLangfuseSettings(): KeyLangfuseSettings {
  return {
    enabled: false,
    publicKey: '',
    secretKey: '',
    baseUrl: 'https://cloud.langfuse.com',
    environment: 'production',
    traceName: '',
    version: '',
    tags: [],
    metadata: {},
    userIdHeader: 'x-user-id',
    sessionIdHeader: 'x-session-id',
    captureInput: true,
    captureOutput: true,
  };
}

export function encryptLangfuseSettings(settings: KeyLangfuseSettings): string {
  return encryptJson(settings);
}

export function decryptLangfuseSettings(
  ciphertext: string | null | undefined,
): KeyLangfuseSettings | undefined {
  if (!ciphertext) return undefined;
  return {
    ...defaultLangfuseSettings(),
    ...decryptJson<Partial<KeyLangfuseSettings>>(ciphertext),
  };
}

export function publicLangfuseSettings(settings?: KeyLangfuseSettings): Record<string, unknown> {
  const value = settings ?? defaultLangfuseSettings();
  return {
    enabled: value.enabled,
    publicKey: value.publicKey,
    hasSecretKey: Boolean(value.secretKey),
    baseUrl: value.baseUrl,
    environment: value.environment,
    traceName: value.traceName,
    version: value.version,
    tags: value.tags,
    metadata: value.metadata,
    userIdHeader: value.userIdHeader,
    sessionIdHeader: value.sessionIdHeader,
    captureInput: value.captureInput,
    captureOutput: value.captureOutput,
    restartRequiredAfterSave: true,
  };
}

export async function saveApiKeyLangfuseSettings(
  apiKeyId: string,
  input: Omit<KeyLangfuseSettings, 'secretKey'> & { secretKey?: string },
): Promise<boolean> {
  const existingResult = await getPool().query<LangfuseKeyRow>(
    'SELECT id, langfuse_config_ciphertext FROM virtual_api_keys WHERE id = $1',
    [apiKeyId],
  );
  const row = existingResult.rows[0];
  if (!row) return false;

  const existing = decryptLangfuseSettings(row.langfuse_config_ciphertext);
  const settings: KeyLangfuseSettings = {
    ...input,
    secretKey: input.secretKey || existing?.secretKey || '',
  };
  if (settings.enabled && (!settings.publicKey || !settings.secretKey)) {
    throw Object.assign(new Error('启用 Langfuse 需要 Public Key 和 Secret Key。'), {
      statusCode: 400,
      code: 'langfuse_credentials_required',
    });
  }

  await getPool().query(
    'UPDATE virtual_api_keys SET langfuse_config_ciphertext = $2 WHERE id = $1',
    [apiKeyId, encryptLangfuseSettings(settings)],
  );
  return true;
}

export async function initializeLangfuse(): Promise<number> {
  const result = await getPool().query<LangfuseKeyRow>(
    `SELECT id, langfuse_config_ciphertext
       FROM virtual_api_keys
      WHERE status = 'active' AND langfuse_config_ciphertext IS NOT NULL`,
  );
  const configured: Array<{ id: string; settings: KeyLangfuseSettings }> = [];

  for (const row of result.rows) {
    try {
      const settings = decryptLangfuseSettings(row.langfuse_config_ciphertext);
      if (settings?.enabled && settings.publicKey && settings.secretKey) {
        configured.push({ id: row.id, settings });
      }
    } catch {
      console.warn(`Skipping invalid Langfuse configuration for API key ${row.id}.`);
    }
  }
  if (!configured.length) return 0;

  telemetrySdk = new NodeSDK({
    spanProcessors: configured.map(
      ({ id, settings }) =>
        new LangfuseSpanProcessor({
          publicKey: settings.publicKey,
          secretKey: settings.secretKey,
          baseUrl: settings.baseUrl,
          environment: settings.environment,
          shouldExportSpan: ({ otelSpan }) => otelSpan.attributes[API_KEY_ATTRIBUTE] === id,
        }),
    ),
  });
  telemetrySdk.start();
  return configured.length;
}

export async function shutdownLangfuse(): Promise<void> {
  if (telemetrySdk) await telemetrySdk.shutdown();
  telemetrySdk = undefined;
}
