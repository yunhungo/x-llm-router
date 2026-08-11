import { randomUUID } from 'node:crypto';

import { getConfig } from '../config';
import { getPool } from '../db/client';
import { decryptJson, encryptJson } from '../lib/crypto';

export const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_DEVICE_FLOW_SECONDS = 15 * 60;
const AUTH_REQUEST_TIMEOUT_MS = 20_000;

type PublicOAuthErrorCode =
  'openai_oauth_unavailable' | 'openai_oauth_rejected' | 'openai_oauth_invalid_response';

type PublicOAuthError = Error & {
  statusCode: 502;
  code: PublicOAuthErrorCode;
  exposeMessage: true;
};

interface AuthorizationCodeResponse {
  authorization_code: string;
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

function publicOAuthError(
  code: PublicOAuthErrorCode,
  message: string,
  cause?: unknown,
): PublicOAuthError {
  const error = (
    cause === undefined ? new Error(message) : new Error(message, { cause })
  ) as PublicOAuthError;
  error.statusCode = 502;
  error.code = code;
  error.exposeMessage = true;
  return error;
}

function responseErrorDetail(response: Response, body: unknown): string {
  let detail: unknown;
  if (typeof body === 'object' && body) {
    const record = body as Record<string, unknown>;
    const nestedError =
      typeof record.error === 'object' && record.error
        ? (record.error as Record<string, unknown>)
        : undefined;
    detail =
      record.message ??
      record.error_description ??
      record.detail ??
      nestedError?.message ??
      (typeof record.error === 'string' ? record.error : undefined);
  }
  const compact =
    typeof detail === 'string' ? detail.replace(/\s+/gu, ' ').trim().slice(0, 500) : '';
  return compact || response.statusText || `HTTP ${response.status}`;
}

function bodyRecord(body: unknown): Record<string, unknown> | undefined {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function oauthTokenResponse(body: unknown): OAuthTokenResponse | undefined {
  const record = bodyRecord(body);
  const accessToken = nonEmptyString(record, 'access_token');
  const idToken = nonEmptyString(record, 'id_token');
  if (!accessToken || !idToken) return undefined;
  const refreshToken = nonEmptyString(record, 'refresh_token');
  return {
    access_token: accessToken,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    id_token: idToken,
  };
}

function apiError(prefix: string, response: Response, body: unknown): PublicOAuthError {
  const code =
    response.status === 408 || response.status === 429 || response.status >= 500
      ? 'openai_oauth_unavailable'
      : 'openai_oauth_rejected';
  return publicOAuthError(
    code,
    `${prefix} (${response.status}): ${responseErrorDetail(response, body)}`,
  );
}

async function requestOpenAiAuth(
  path: string,
  operation: string,
  init: RequestInit,
): Promise<{ response: Response; body: unknown }> {
  try {
    const response = await fetch(authUrl(path), {
      ...init,
      signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
    });
    const body = await readJsonOrText(response);
    return { response, body };
  } catch (cause) {
    throw publicOAuthError(
      'openai_oauth_unavailable',
      `无法连接 OpenAI OAuth 服务（${operation}）。请检查容器 DNS、HTTPS_PROXY、NODE_USE_ENV_PROXY 和受信任 CA 配置。`,
      cause,
    );
  }
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
  const { response, body } = await requestOpenAiAuth(
    '/api/accounts/deviceauth/usercode',
    '申请设备码',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
    },
  );
  if (!response.ok) throw apiError('OpenAI device authorization failed', response, body);

  const record = bodyRecord(body);
  const deviceAuthId = nonEmptyString(record, 'device_auth_id');
  const userCode = nonEmptyString(record, 'user_code') ?? nonEmptyString(record, 'usercode');
  if (!deviceAuthId || !userCode) {
    throw publicOAuthError('openai_oauth_invalid_response', 'OpenAI 设备授权响应缺少必要字段。');
  }

  const parsedInterval = Number(record?.interval ?? 5);
  if (!Number.isFinite(parsedInterval) || parsedInterval <= 0) {
    throw publicOAuthError(
      'openai_oauth_invalid_response',
      'OpenAI 设备授权响应包含无效轮询间隔。',
    );
  }
  const intervalSeconds = Math.min(60, Math.max(5, Math.ceil(parsedInterval)));
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
      encryptJson({ deviceAuthId }),
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
  const { response, body } = await requestOpenAiAuth('/oauth/token', '交换访问令牌', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (!response.ok) throw apiError('OpenAI token exchange failed', response, body);
  const tokens = oauthTokenResponse(body);
  if (!tokens?.refresh_token) {
    throw publicOAuthError('openai_oauth_invalid_response', 'OpenAI 令牌交换响应缺少必要字段。');
  }
  return tokens;
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
  const { response, body } = await requestOpenAiAuth(
    '/api/accounts/deviceauth/token',
    '轮询设备授权状态',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: flow.user_code }),
    },
  );
  if (response.status === 403 || response.status === 404) return { status: 'pending' };
  if (!response.ok) {
    const error = apiError('OpenAI device authorization polling failed', response, body);
    if (error.code === 'openai_oauth_rejected') {
      await getPool().query(
        `UPDATE oauth_device_flows SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`,
        [flow.id, error.message],
      );
    }
    throw error;
  }
  const record = bodyRecord(body);
  const authorizationCode = nonEmptyString(record, 'authorization_code');
  const codeVerifier = nonEmptyString(record, 'code_verifier');
  if (!authorizationCode || !codeVerifier) {
    throw publicOAuthError('openai_oauth_invalid_response', 'OpenAI 设备授权轮询响应不完整。');
  }

  const tokens = await exchangeAuthorizationCode({
    authorization_code: authorizationCode,
    code_verifier: codeVerifier,
  });
  const refreshToken = tokens.refresh_token;
  if (!refreshToken) throw new Error('OpenAI token exchange did not return a refresh token.');
  const metadata = tokenMetadata(tokens.id_token || tokens.access_token);
  const providerConnectionId = randomUUID();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO provider_connections(
        id, name, provider, auth_type, api_mode, credentials_ciphertext, account_id, base_url,
        token_expires_at, created_by
      ) VALUES ($1,$2,'openai','oauth','responses',$3,$4,$5,$6,$7)`,
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
  const { response, body } = await requestOpenAiAuth('/oauth/token', '刷新访问令牌', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: OPENAI_CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      scope: 'openid profile email',
    }),
  });
  if (!response.ok) throw apiError('OpenAI token refresh failed', response, body);
  const tokens = oauthTokenResponse(body);
  if (!tokens)
    throw publicOAuthError('openai_oauth_invalid_response', 'OpenAI 令牌刷新响应不完整。');

  const next: OAuthCredentials = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? credentials.refreshToken,
    idToken: tokens.id_token,
  };
  const metadata = tokenMetadata(next.idToken || next.accessToken);
  return { credentials: next, ...metadata };
}
