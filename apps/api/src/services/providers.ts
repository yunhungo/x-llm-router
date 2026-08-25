import { getPool } from '../db/client';
import { decryptJson, encryptJson } from '../lib/crypto';
import { getPiProviderDefinition } from '../providers/pi-ai';
import type { GatewayEndpoint } from '../providers/types';
import {
  codexClientHeaders,
  discoverOpenAiModels,
  type OAuthCredentials,
  refreshOAuthCredentials,
} from './openai-oauth';

interface ProviderRow {
  id: string;
  name: string;
  provider: string;
  auth_type: 'oauth' | 'api_key';
  api_mode: GatewayEndpoint;
  credentials_ciphertext: string;
  account_id: string | null;
  base_url: string;
  default_model: string | null;
  token_expires_at: Date | null;
}

interface ApiKeyCredentials {
  apiKey: string;
}

async function getProviderModelRuntime(providerId: string): Promise<ProviderRuntime> {
  const result = await getPool().query<ProviderRow>(
    `SELECT id, name, provider, auth_type, api_mode, credentials_ciphertext, account_id, base_url,
            default_model, token_expires_at
       FROM provider_connections
      WHERE id = $1
      LIMIT 1`,
    [providerId],
  );
  const row = result.rows[0];
  if (!row) {
    throw Object.assign(new Error('上游连接不存在。'), {
      statusCode: 404,
      code: 'provider_not_found',
      exposeMessage: true,
    });
  }
  if (row.auth_type === 'api_key') {
    const credentials = decryptJson<ApiKeyCredentials>(row.credentials_ciphertext);
    return {
      id: row.id,
      name: row.name,
      provider: row.provider,
      authType: row.auth_type,
      apiMode: row.api_mode,
      baseUrl: row.base_url.replace(/\/$/, ''),
      defaultModel: row.default_model,
      authorization: `Bearer ${credentials.apiKey}`,
      apiKey: credentials.apiKey,
      headers: {},
    };
  }

  let credentials = decryptJson<OAuthCredentials>(row.credentials_ciphertext);
  const expiresAt = row.token_expires_at ? new Date(row.token_expires_at).getTime() : 0;
  if (expiresAt <= Date.now() + 60_000) {
    const refreshed = await refreshOAuthCredentials(credentials);
    credentials = refreshed.credentials;
    row.account_id = refreshed.accountId;
    await getPool().query(
      `UPDATE provider_connections
          SET credentials_ciphertext = $2, token_expires_at = $3, account_id = $4,
              last_error = NULL, updated_at = now()
        WHERE id = $1`,
      [row.id, encryptJson(credentials), refreshed.expiresAt, refreshed.accountId],
    );
  }

  const headers: Record<string, string> = codexClientHeaders();
  if (row.account_id) headers['ChatGPT-Account-Id'] = row.account_id;
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    authType: row.auth_type,
    apiMode: row.api_mode,
    baseUrl: row.base_url.replace(/\/$/, ''),
    defaultModel: row.default_model,
    authorization: `Bearer ${credentials.accessToken}`,
    headers,
  };
}

export interface ProviderRuntime {
  id: string;
  name: string;
  provider: string;
  authType: 'oauth' | 'api_key';
  apiMode: GatewayEndpoint;
  baseUrl: string;
  defaultModel: string | null;
  authorization: string;
  apiKey?: string;
  headers: Record<string, string>;
}

export async function refreshProviderModels(providerId: string): Promise<{
  models: string[];
  refreshedAt: string;
}> {
  const runtime = await getProviderModelRuntime(providerId);

  try {
    const builtInModels =
      runtime.authType === 'api_key'
        ? (getPiProviderDefinition(runtime.provider)?.models ?? [])
        : [];
    const models =
      builtInModels.length > 0
        ? builtInModels
        : await discoverOpenAiModels({
            baseUrl: runtime.baseUrl,
            authorization: runtime.authorization,
            headers: runtime.headers,
          });
    const refreshedAt = new Date();
    await getPool().query(
      `UPDATE provider_connections
          SET available_models = $2::jsonb, models_refreshed_at = $3,
              models_refresh_error = NULL, updated_at = now()
        WHERE id = $1`,
      [providerId, JSON.stringify(models), refreshedAt],
    );
    return { models, refreshedAt: refreshedAt.toISOString() };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
    await getPool().query(
      `UPDATE provider_connections
          SET models_refresh_error = $2, updated_at = now()
        WHERE id = $1`,
      [providerId, message],
    );
    if (error instanceof Error) {
      Object.assign(error, { exposeMessage: true });
    }
    throw error;
  }
}

export async function getProviderRuntime(
  preferredId: string | null,
  sessionId: string,
  _endpoint: GatewayEndpoint,
): Promise<ProviderRuntime> {
  const result = await getPool().query<ProviderRow>(
    `SELECT id, name, provider, auth_type, api_mode, credentials_ciphertext, account_id, base_url,
            default_model, token_expires_at
       FROM provider_connections
      WHERE status = 'active'
        AND (
          ($1::uuid IS NOT NULL AND id = $1)
          OR $1::uuid IS NULL
        )
      ORDER BY CASE WHEN id = $1 THEN 0 ELSE 1 END, priority ASC, created_at ASC
      LIMIT 1`,
    [preferredId],
  );
  const row = result.rows[0];
  if (!row) {
    throw Object.assign(new Error('No active upstream provider connection is configured.'), {
      statusCode: 503,
      code: 'provider_unavailable',
    });
  }

  if (row.auth_type === 'api_key') {
    const credentials = decryptJson<ApiKeyCredentials>(row.credentials_ciphertext);
    return {
      id: row.id,
      name: row.name,
      provider: row.provider,
      authType: row.auth_type,
      apiMode: row.api_mode,
      baseUrl: row.base_url.replace(/\/$/, ''),
      defaultModel: row.default_model,
      authorization: `Bearer ${credentials.apiKey}`,
      apiKey: credentials.apiKey,
      headers: {},
    };
  }

  let credentials = decryptJson<OAuthCredentials>(row.credentials_ciphertext);
  const expiresAt = row.token_expires_at ? new Date(row.token_expires_at).getTime() : 0;
  if (expiresAt <= Date.now() + 60_000) {
    try {
      const refreshed = await refreshOAuthCredentials(credentials);
      credentials = refreshed.credentials;
      await getPool().query(
        `UPDATE provider_connections
            SET credentials_ciphertext = $2, token_expires_at = $3, account_id = $4,
                status = 'active', last_error = NULL, updated_at = now()
          WHERE id = $1`,
        [row.id, encryptJson(credentials), refreshed.expiresAt, refreshed.accountId],
      );
      row.account_id = refreshed.accountId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await getPool().query(
        `UPDATE provider_connections SET status = 'error', last_error = $2, updated_at = now() WHERE id = $1`,
        [row.id, message],
      );
      throw Object.assign(new Error(`OpenAI OAuth refresh failed: ${message}`), {
        statusCode: 503,
        code: 'provider_authentication_failed',
      });
    }
  }

  const headers: Record<string, string> = {
    ...codexClientHeaders(),
    session_id: sessionId,
  };
  if (row.account_id) headers['ChatGPT-Account-Id'] = row.account_id;
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    authType: row.auth_type,
    apiMode: row.api_mode,
    baseUrl: row.base_url.replace(/\/$/, ''),
    defaultModel: row.default_model,
    authorization: `Bearer ${credentials.accessToken}`,
    headers,
  };
}
