import { randomUUID } from 'node:crypto';

import { getPool } from '../db/client';
import { encryptJson } from '../lib/crypto';
import { prepareStoredJson, prepareStoredRequest } from './usage-details';

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
  totalTokens: number;
}

export const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: null,
  totalTokens: 0,
});

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function extractTokenUsage(payload: unknown): TokenUsage {
  if (!payload || typeof payload !== 'object') return emptyUsage();
  const record = payload as Record<string, unknown>;
  const usage =
    record.usage && typeof record.usage === 'object'
      ? (record.usage as Record<string, unknown>)
      : record.response && typeof record.response === 'object'
        ? ((record.response as Record<string, unknown>).usage as
            Record<string, unknown> | undefined)
        : undefined;
  if (!usage) return emptyUsage();
  const inputTokens = numberValue(usage.input_tokens ?? usage.prompt_tokens);
  const inputDetails = (
    usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
      ? usage.input_tokens_details
      : usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
        ? usage.prompt_tokens_details
        : {}
  ) as Record<string, unknown>;
  const cachedInputTokens = numberValue(
    inputDetails.cached_tokens ?? usage.prompt_cache_hit_tokens,
  );
  const outputTokens = numberValue(usage.output_tokens ?? usage.completion_tokens);
  const outputDetails =
    usage.output_tokens_details && typeof usage.output_tokens_details === 'object'
      ? (usage.output_tokens_details as Record<string, unknown>)
      : {};
  const completionDetails =
    usage.completion_tokens_details && typeof usage.completion_tokens_details === 'object'
      ? (usage.completion_tokens_details as Record<string, unknown>)
      : {};
  const rawReasoningTokens =
    outputDetails.reasoning_tokens ?? completionDetails.reasoning_tokens ?? usage.reasoning_tokens;
  const reasoningTokens =
    typeof rawReasoningTokens === 'number' && Number.isFinite(rawReasoningTokens)
      ? rawReasoningTokens
      : null;
  const totalTokens = numberValue(usage.total_tokens) || inputTokens + outputTokens;
  return { inputTokens, cachedInputTokens, outputTokens, reasoningTokens, totalTokens };
}

export interface ModelPrice {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
}

export interface UsageCallDetails {
  gatewayCurl: string;
  routerApiToken?: string;
  upstreamCurl?: string;
  clientRequest: unknown;
  upstreamRequest?: unknown;
  upstreamResponse?: unknown;
  error?: unknown;
}

export type UsageCallStatus = 'processing' | 'thinking' | 'responding' | 'completed' | 'failed';

export async function beginUsage(input: {
  requestId: string;
  virtualApiKeyId: string;
  endpoint: 'responses' | 'chat.completions';
  requestedModel: string;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO usage_logs(
       id, request_id, virtual_api_key_id, endpoint, requested_model, model,
       call_status, status_code, success
     ) VALUES ($1,$2,$3,$4,$5,$6,'processing',NULL,NULL)
     ON CONFLICT (request_id) DO NOTHING`,
    [
      randomUUID(),
      input.requestId,
      input.virtualApiKeyId,
      input.endpoint,
      input.requestedModel,
      input.requestedModel,
    ],
  );
}

export async function updateUsageCallStatus(
  requestId: string,
  callStatus: Extract<UsageCallStatus, 'thinking' | 'responding'>,
): Promise<void> {
  await getPool().query(
    `UPDATE usage_logs
        SET call_status = $2
      WHERE request_id = $1
        AND (($2 = 'thinking' AND call_status = 'processing')
          OR ($2 = 'responding' AND call_status IN ('processing', 'thinking')))`,
    [requestId, callStatus],
  );
}

export function computeCost(usage: TokenUsage, price: ModelPrice): number {
  const cachedInputTokens = Math.min(usage.inputTokens, usage.cachedInputTokens);
  const uncachedInputTokens = Math.max(usage.inputTokens - cachedInputTokens, 0);
  return (
    (uncachedInputTokens * price.inputPerMillion +
      cachedInputTokens * price.cachedInputPerMillion +
      usage.outputTokens * price.outputPerMillion) /
    1_000_000
  );
}

export async function calculateCost(
  virtualApiKeyId: string,
  provider: string,
  model: string,
  usage: TokenUsage,
): Promise<number> {
  const result = await getPool().query<{
    input_per_million: string;
    cached_input_per_million: string;
    output_per_million: string;
  }>(
    `SELECT input_per_million, cached_input_per_million, output_per_million
       FROM model_prices
      WHERE (virtual_api_key_id = $1 OR virtual_api_key_id IS NULL)
        AND provider IN ($2, '*')
        AND ($3 = model_pattern OR $3 LIKE model_pattern || '%')
      ORDER BY CASE WHEN virtual_api_key_id = $1 THEN 0 ELSE 1 END,
               CASE WHEN provider = $2 THEN 0 ELSE 1 END,
               length(model_pattern) DESC
      LIMIT 1`,
    [virtualApiKeyId, provider, model],
  );
  const price = result.rows[0];
  if (!price) return 0;
  return computeCost(usage, {
    inputPerMillion: Number(price.input_per_million),
    cachedInputPerMillion: Number(price.cached_input_per_million),
    outputPerMillion: Number(price.output_per_million),
  });
}

export async function recordUsage(input: {
  requestId: string;
  virtualApiKeyId: string;
  providerConnectionId?: string;
  provider?: string;
  endpoint: 'responses' | 'chat.completions';
  requestedModel: string;
  model: string;
  statusCode: number;
  usage: TokenUsage;
  latencyMs: number;
  timeToFirstTokenMs?: number;
  timeToFirstVisibleTokenMs?: number;
  errorCode?: string;
  reportedCostUsd?: number;
  metadata?: Record<string, unknown>;
  details?: UsageCallDetails;
}): Promise<{ costUsd: number }> {
  const costUsd =
    input.reportedCostUsd !== undefined &&
    Number.isFinite(input.reportedCostUsd) &&
    input.reportedCostUsd >= 0
      ? input.reportedCostUsd
      : await calculateCost(input.virtualApiKeyId, input.provider ?? '*', input.model, input.usage);
  const newUsageLogId = randomUUID();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const finalStatus: UsageCallStatus =
      input.statusCode >= 200 && input.statusCode < 400 ? 'completed' : 'failed';
    const recorded = await client.query<{ id: string }>(
      `INSERT INTO usage_logs(
        id, request_id, virtual_api_key_id, provider_connection_id, endpoint, requested_model, model,
        call_status, status_code, success, input_tokens, cached_input_tokens, output_tokens,
        reasoning_tokens, total_tokens, cost_usd, latency_ms, time_to_first_token_ms,
        time_to_first_visible_token_ms, error_code, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb)
      ON CONFLICT (request_id) DO UPDATE SET
        virtual_api_key_id = EXCLUDED.virtual_api_key_id,
        provider_connection_id = EXCLUDED.provider_connection_id,
        endpoint = EXCLUDED.endpoint,
        requested_model = EXCLUDED.requested_model,
        model = EXCLUDED.model,
        call_status = EXCLUDED.call_status,
        status_code = EXCLUDED.status_code,
        success = EXCLUDED.success,
        input_tokens = EXCLUDED.input_tokens,
        cached_input_tokens = EXCLUDED.cached_input_tokens,
        output_tokens = EXCLUDED.output_tokens,
        reasoning_tokens = EXCLUDED.reasoning_tokens,
        total_tokens = EXCLUDED.total_tokens,
        cost_usd = EXCLUDED.cost_usd,
        latency_ms = EXCLUDED.latency_ms,
        time_to_first_token_ms = EXCLUDED.time_to_first_token_ms,
        time_to_first_visible_token_ms = EXCLUDED.time_to_first_visible_token_ms,
        error_code = EXCLUDED.error_code,
        metadata = EXCLUDED.metadata
      WHERE usage_logs.call_status IN ('processing', 'thinking', 'responding')
      RETURNING id`,
      [
        newUsageLogId,
        input.requestId,
        input.virtualApiKeyId,
        input.providerConnectionId ?? null,
        input.endpoint,
        input.requestedModel,
        input.model,
        finalStatus,
        input.statusCode,
        input.statusCode >= 200 && input.statusCode < 400,
        input.usage.inputTokens,
        input.usage.cachedInputTokens,
        input.usage.outputTokens,
        input.usage.reasoningTokens,
        input.usage.totalTokens,
        costUsd,
        input.latencyMs,
        input.timeToFirstTokenMs ?? null,
        input.timeToFirstVisibleTokenMs ?? null,
        input.errorCode ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    const usageLogId = recorded.rows[0]?.id;
    if (usageLogId && input.details) {
      await client.query(
        `INSERT INTO usage_log_details(
           usage_log_id, gateway_curl, router_api_token_ciphertext, upstream_curl,
           client_request, upstream_request, upstream_response, error
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)
         ON CONFLICT (usage_log_id) DO UPDATE SET
           gateway_curl = EXCLUDED.gateway_curl,
           router_api_token_ciphertext = EXCLUDED.router_api_token_ciphertext,
           upstream_curl = EXCLUDED.upstream_curl,
           client_request = EXCLUDED.client_request,
           upstream_request = EXCLUDED.upstream_request,
           upstream_response = EXCLUDED.upstream_response,
           error = EXCLUDED.error,
           captured_at = now(),
           expires_at = now() + interval '30 days'`,
        [
          usageLogId,
          input.details.gatewayCurl,
          input.details.routerApiToken ? encryptJson(input.details.routerApiToken) : null,
          input.details.upstreamCurl ?? null,
          JSON.stringify(prepareStoredRequest(input.details.clientRequest)),
          input.details.upstreamRequest === undefined
            ? null
            : JSON.stringify(prepareStoredRequest(input.details.upstreamRequest)),
          input.details.upstreamResponse === undefined
            ? null
            : JSON.stringify(prepareStoredJson(input.details.upstreamResponse)),
          input.details.error === undefined
            ? null
            : JSON.stringify(prepareStoredJson(input.details.error)),
        ],
      );
    }
    if (usageLogId && costUsd > 0) {
      await client.query(
        `UPDATE virtual_api_keys SET spend_usd = spend_usd + $2, last_used_at = now() WHERE id = $1`,
        [input.virtualApiKeyId, costUsd],
      );
    } else if (usageLogId) {
      await client.query('UPDATE virtual_api_keys SET last_used_at = now() WHERE id = $1', [
        input.virtualApiKeyId,
      ]);
    }
    await client.query('COMMIT');
    return { costUsd };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
