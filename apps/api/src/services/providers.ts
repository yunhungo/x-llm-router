import { getPool } from '../db/client';
import { decryptJson, encryptJson } from '../lib/crypto';
import type { GatewayEndpoint } from '../providers/types';
import { type OAuthCredentials, refreshOAuthCredentials } from './openai-oauth';

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

export interface ProviderRuntime {
  id: string;
  name: string;
  provider: string;
  authType: 'oauth' | 'api_key';
  apiMode: GatewayEndpoint;
  baseUrl: string;
  defaultModel: string | null;
  authorization: string;
  headers: Record<string, string>;
}

export async function getProviderRuntime(
  preferredId: string | null,
  sessionId: string,
  endpoint: GatewayEndpoint,
): Promise<ProviderRuntime> {
  const result = await getPool().query<ProviderRow>(
    `SELECT id, name, provider, auth_type, api_mode, credentials_ciphertext, account_id, base_url,
            default_model, token_expires_at
       FROM provider_connections
      WHERE status = 'active'
        AND (
          ($1::uuid IS NOT NULL AND id = $1)
          OR ($1::uuid IS NULL AND (auth_type = 'oauth' OR api_mode = $2))
        )
      ORDER BY CASE WHEN id = $1 THEN 0 ELSE 1 END, priority ASC, created_at ASC
      LIMIT 1`,
    [preferredId, endpoint],
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
    originator: 'codex_cli_rs',
    'user-agent': 'x-llm-router/0.1.0',
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
