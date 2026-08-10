import { randomUUID } from 'node:crypto';

import { getPool } from '../db/client';

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
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
  const totalTokens = numberValue(usage.total_tokens) || inputTokens + outputTokens;
  return { inputTokens, cachedInputTokens, outputTokens, totalTokens };
}

export async function calculateCost(model: string, usage: TokenUsage): Promise<number> {
  const result = await getPool().query<{ input_per_million: string; output_per_million: string }>(
    `SELECT input_per_million, output_per_million
       FROM model_prices
      WHERE $1 = model_pattern OR $1 LIKE model_pattern || '%'
      ORDER BY length(model_pattern) DESC
      LIMIT 1`,
    [model],
  );
  const price = result.rows[0];
  if (!price) return 0;
  return (
    (usage.inputTokens * Number(price.input_per_million) +
      usage.outputTokens * Number(price.output_per_million)) /
    1_000_000
  );
}

export async function recordUsage(input: {
  requestId: string;
  virtualApiKeyId: string;
  providerConnectionId?: string;
  endpoint: 'responses' | 'chat.completions';
  model: string;
  statusCode: number;
  usage: TokenUsage;
  latencyMs: number;
  timeToFirstTokenMs?: number;
  errorCode?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ costUsd: number }> {
  const costUsd = await calculateCost(input.model, input.usage);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO usage_logs(
        id, request_id, virtual_api_key_id, provider_connection_id, endpoint, model,
        status_code, success, input_tokens, output_tokens, total_tokens, cost_usd,
        latency_ms, time_to_first_token_ms, error_code, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
      ON CONFLICT (request_id) DO NOTHING`,
      [
        randomUUID(),
        input.requestId,
        input.virtualApiKeyId,
        input.providerConnectionId ?? null,
        input.endpoint,
        input.model,
        input.statusCode,
        input.statusCode >= 200 && input.statusCode < 400,
        input.usage.inputTokens,
        input.usage.outputTokens,
        input.usage.totalTokens,
        costUsd,
        input.latencyMs,
        input.timeToFirstTokenMs ?? null,
        input.errorCode ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    if (costUsd > 0) {
      await client.query(
        `UPDATE virtual_api_keys SET spend_usd = spend_usd + $2, last_used_at = now() WHERE id = $1`,
        [input.virtualApiKeyId, costUsd],
      );
    } else {
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
