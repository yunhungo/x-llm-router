/**
 * @created 2026-08-10
 * @description 解析上游运行凭据并同步、持久化模型目录及失败状态。
 * @author yunhungo
 */
import type { ModelCatalog, ModelCatalogRefresh } from '@x-router/contracts';

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
  models_client_version?: string | null;
}

interface ApiKeyCredentials {
  apiKey: string;
}

interface OAuthConnection {
  credentials: OAuthCredentials;
  accountId: string | null;
}

const credentialRefreshes = new Map<string, Promise<OAuthConnection>>();

async function oauthConnection(row: ProviderRow): Promise<OAuthConnection> {
  const active = credentialRefreshes.get(row.id);
  if (active) return active;
  if (row.token_expires_at && new Date(row.token_expires_at).getTime() > Date.now() + 60_000) {
    return {
      credentials: decryptJson<OAuthCredentials>(row.credentials_ciphertext),
      accountId: row.account_id,
    };
  }
  const task = (async () => {
    // Re-read after joining the refresh queue; another request may have rotated this token.
    const current = await getPool().query<ProviderRow>(
      'SELECT credentials_ciphertext, token_expires_at, account_id FROM provider_connections WHERE id = $1',
      [row.id],
    );
    const latest = current.rows[0];
    if (!latest) throw new Error('上游连接已移除。');
    const credentials = decryptJson<OAuthCredentials>(latest.credentials_ciphertext);
    if (
      latest.token_expires_at &&
      new Date(latest.token_expires_at).getTime() > Date.now() + 60_000
    ) {
      return { credentials, accountId: latest.account_id };
    }
    const refreshed = await refreshOAuthCredentials(credentials);
    await getPool().query(
      `UPDATE provider_connections
          SET credentials_ciphertext = $2, token_expires_at = $3, account_id = $4,
              last_error = NULL, updated_at = now()
        WHERE id = $1`,
      [row.id, encryptJson(refreshed.credentials), refreshed.expiresAt, refreshed.accountId],
    );
    return { credentials: refreshed.credentials, accountId: refreshed.accountId };
  })().finally(() => credentialRefreshes.delete(row.id));
  credentialRefreshes.set(row.id, task);
  return task;
}

async function getProviderModelRuntime(providerId: string): Promise<ProviderRuntime> {
  const result = await getPool().query<ProviderRow>(
    `SELECT id, name, provider, auth_type, api_mode, credentials_ciphertext, account_id, base_url,
            default_model, token_expires_at, models_client_version
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

  const { credentials, accountId } = await oauthConnection(row);

  const headers: Record<string, string> = codexClientHeaders();
  if (accountId) headers['ChatGPT-Account-Id'] = accountId;
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    authType: row.auth_type,
    apiMode: row.api_mode,
    baseUrl: row.base_url.replace(/\/$/, ''),
    defaultModel: row.default_model,
    authorization: `Bearer ${credentials.accessToken}`,
    modelsClientVersion: row.models_client_version ?? null,
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
  modelsClientVersion?: string | null;
  headers: Record<string, string>;
}

const modelRefreshes = new Map<string, Promise<ModelCatalogRefresh>>();

async function syncProviderModels(
  providerId: string,
  signal?: AbortSignal,
): Promise<ModelCatalogRefresh> {
  try {
    const runtime = await getProviderModelRuntime(providerId);
    const builtInModels =
      runtime.authType === 'api_key' && runtime.provider !== 'openai'
        ? (getPiProviderDefinition(runtime.provider)?.models ?? [])
        : [];
    const catalog: ModelCatalog =
      builtInModels.length > 0
        ? { models: builtInModels, source: 'builtin', clientVersion: null, warning: null }
        : await discoverOpenAiModels({
            authType: runtime.authType,
            previousClientVersion: runtime.modelsClientVersion ?? null,
            baseUrl: runtime.baseUrl,
            authorization: runtime.authorization,
            headers: runtime.headers,
            ...(signal ? { signal } : {}),
          });
    const refreshedAt = new Date();
    await getPool().query(
      `UPDATE provider_connections
          SET available_models = $2::jsonb, models_refreshed_at = $3,
              models_refresh_error = NULL, models_checked_at = $3,
              models_source = $4, models_client_version = $5,
              models_refresh_warning = $6, updated_at = now()
        WHERE id = $1`,
      [
        providerId,
        JSON.stringify(catalog.models),
        refreshedAt,
        catalog.source,
        catalog.clientVersion,
        catalog.warning,
      ],
    );
    return { ...catalog, refreshedAt: refreshedAt.toISOString() };
  } catch (error) {
    if (signal?.aborted) throw error;
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
    await getPool().query(
      `UPDATE provider_connections
          SET models_refresh_error = $2, models_checked_at = now(), updated_at = now()
        WHERE id = $1`,
      [providerId, message],
    );
    if (error instanceof Error) {
      Object.assign(error, { exposeMessage: true });
    }
    throw error;
  }
}

export function refreshProviderModels(
  providerId: string,
  signal?: AbortSignal,
): Promise<ModelCatalogRefresh> {
  const pending = modelRefreshes.get(providerId);
  if (pending) return pending;
  const task = syncProviderModels(providerId, signal).finally(() =>
    modelRefreshes.delete(providerId),
  );
  modelRefreshes.set(providerId, task);
  return task;
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

  let connection: OAuthConnection;
  try {
    connection = await oauthConnection(row);
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

  const headers: Record<string, string> = {
    ...codexClientHeaders(),
    session_id: sessionId,
  };
  if (connection.accountId) headers['ChatGPT-Account-Id'] = connection.accountId;
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    authType: row.auth_type,
    apiMode: row.api_mode,
    baseUrl: row.base_url.replace(/\/$/, ''),
    defaultModel: row.default_model,
    authorization: `Bearer ${connection.credentials.accessToken}`,
    headers,
  };
}
