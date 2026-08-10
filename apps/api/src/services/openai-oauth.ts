import { randomUUID } from 'node:crypto';

import { getConfig } from '../config';
import { getPool } from '../db/client';
import { decryptJson, encryptJson } from '../lib/crypto';

export const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_DEVICE_FLOW_SECONDS = 15 * 60;

interface DeviceCodeResponse {
  device_auth_id: string;
  user_code?: string;
  usercode?: string;
  interval?: string | number;
}

interface AuthorizationCodeResponse {
  authorization_code: string;
  code_challenge: string;
  code_verifier: string;
}

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token: string;
}

export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  idToken: string;
}

interface DeviceFlowRow {
  id: string;
  desired_name: string;
  device_auth_id_ciphertext: string;
  user_code: string;
  status: 'pending' | 'complete' | 'expired' | 'failed';
  expires_at: Date;
}

function authUrl(path: string): string {
  return `${getConfig().CHATGPT_AUTH_BASE.replace(/\/$/, '')}${path}`;
}

async function readJsonOrText(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function apiError(prefix: string, response: Response, body: unknown): Error {
  const detail =
    typeof body === 'object' && body && 'message' in body
      ? String((body as { message: unknown }).message)
      : response.statusText;
  return new Error(`${prefix} (${response.status}): ${detail}`);
}

function decodeJwtClaims(token: string): Record<string, unknown> {
  try {
    const payload = token.split('.')[1];
    if (!payload) return {};
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

export function tokenMetadata(token: string): { expiresAt: Date | null; accountId: string | null } {
  const claims = decodeJwtClaims(token);
  const exp = typeof claims.exp === 'number' ? new Date(claims.exp * 1000) : null;
  const auth = claims['https://api.openai.com/auth'];
  const accountId =
    typeof auth === 'object' && auth && 'chatgpt_account_id' in auth
      ? String((auth as { chatgpt_account_id: unknown }).chatgpt_account_id)
      : null;
  return { expiresAt: exp, accountId };
}

export async function startDeviceFlow(input: { name: string; createdBy: string }): Promise<{
  id: string;
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
  expiresAt: string;
}> {
  const response = await fetch(authUrl('/api/accounts/deviceauth/usercode'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
  });
  const body = (await readJsonOrText(response)) as DeviceCodeResponse;
  if (!response.ok) throw apiError('OpenAI device authorization failed', response, body);

  const userCode = body.user_code ?? body.usercode;
  if (!body.device_auth_id || !userCode) {
    throw new Error('OpenAI device authorization response is missing required fields.');
  }

  const intervalSeconds = Math.max(5, Number(body.interval ?? 5));
  const expiresAt = new Date(Date.now() + DEFAULT_DEVICE_FLOW_SECONDS * 1000);
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO oauth_device_flows(
      id, provider, desired_name, device_auth_id_ciphertext, user_code,
      verification_url, poll_interval_seconds, expires_at, created_by
    ) VALUES ($1, 'openai', $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      input.name,
      encryptJson({ deviceAuthId: body.device_auth_id }),
      userCode,
      authUrl('/codex/device'),
      intervalSeconds,
      expiresAt,
      input.createdBy,
    ],
  );
  return {
    id,
    userCode,
    verificationUrl: authUrl('/codex/device'),
    intervalSeconds,
    expiresAt: expiresAt.toISOString(),
  };
}

async function exchangeAuthorizationCode(
  code: AuthorizationCodeResponse,
): Promise<OAuthTokenResponse> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code.authorization_code,
    redirect_uri: authUrl('/deviceauth/callback'),
    client_id: OPENAI_CODEX_CLIENT_ID,
    code_verifier: code.code_verifier,
  });
  const response = await fetch(authUrl('/oauth/token'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const body = (await readJsonOrText(response)) as OAuthTokenResponse;
  if (!response.ok) throw apiError('OpenAI token exchange failed', response, body);
  if (!body.access_token || !body.refresh_token || !body.id_token) {
    throw new Error('OpenAI token exchange response is missing required fields.');
  }
  return body;
}

export async function pollDeviceFlow(input: {
  id: string;
  requestedBy: string;
}): Promise<{ status: DeviceFlowRow['status']; providerConnectionId?: string; message?: string }> {
  const result = await getPool().query<DeviceFlowRow>(
    `SELECT id, desired_name, device_auth_id_ciphertext, user_code, status, expires_at
       FROM oauth_device_flows WHERE id = $1 AND created_by = $2`,
    [input.id, input.requestedBy],
  );
  const flow = result.rows[0];
  if (!flow) throw new Error('OAuth device flow not found.');
  if (flow.status !== 'pending') return { status: flow.status };
  if (new Date(flow.expires_at).getTime() <= Date.now()) {
    await getPool().query(
      `UPDATE oauth_device_flows SET status = 'expired', updated_at = now() WHERE id = $1`,
      [flow.id],
    );
    return { status: 'expired' };
  }

  const { deviceAuthId } = decryptJson<{ deviceAuthId: string }>(flow.device_auth_id_ciphertext);
  const response = await fetch(authUrl('/api/accounts/deviceauth/token'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: flow.user_code }),
  });
  if (response.status === 403 || response.status === 404) return { status: 'pending' };
  const body = (await readJsonOrText(response)) as AuthorizationCodeResponse;
  if (!response.ok) {
    const error = apiError('OpenAI device authorization polling failed', response, body);
    await getPool().query(
      `UPDATE oauth_device_flows SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`,
      [flow.id, error.message],
    );
    throw error;
  }
  if (!body.authorization_code || !body.code_verifier) {
    throw new Error('OpenAI device authorization polling response is incomplete.');
  }

  const tokens = await exchangeAuthorizationCode(body);
  const refreshToken = tokens.refresh_token;
  if (!refreshToken) throw new Error('OpenAI token exchange did not return a refresh token.');
  const metadata = tokenMetadata(tokens.id_token || tokens.access_token);
  const providerConnectionId = randomUUID();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO provider_connections(
        id, name, provider, auth_type, credentials_ciphertext, account_id, base_url,
        token_expires_at, created_by
      ) VALUES ($1,$2,'openai','oauth',$3,$4,$5,$6,$7)`,
      [
        providerConnectionId,
        flow.desired_name,
        encryptJson({
          accessToken: tokens.access_token,
          refreshToken,
          idToken: tokens.id_token,
        } satisfies OAuthCredentials),
        metadata.accountId,
        getConfig().CHATGPT_API_BASE,
        metadata.expiresAt,
        input.requestedBy,
      ],
    );
    await client.query(
      `UPDATE oauth_device_flows SET status = 'complete', updated_at = now() WHERE id = $1`,
      [flow.id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { status: 'complete', providerConnectionId };
}

export async function refreshOAuthCredentials(
  credentials: OAuthCredentials,
): Promise<{ credentials: OAuthCredentials; expiresAt: Date | null; accountId: string | null }> {
  const response = await fetch(authUrl('/oauth/token'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: OPENAI_CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      scope: 'openid profile email',
    }),
  });
  const body = (await readJsonOrText(response)) as OAuthTokenResponse;
  if (!response.ok) throw apiError('OpenAI token refresh failed', response, body);
  if (!body.access_token || !body.id_token)
    throw new Error('OpenAI token refresh response is incomplete.');

  const next: OAuthCredentials = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? credentials.refreshToken,
    idToken: body.id_token,
  };
  const metadata = tokenMetadata(next.idToken || next.accessToken);
  return { credentials: next, ...metadata };
}
