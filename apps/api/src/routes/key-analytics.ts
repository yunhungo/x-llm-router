import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getPool } from '../db/client';
import { requireAdmin } from '../lib/admin-auth';
import { decryptLangfuseSettings, publicLangfuseSettings } from '../services/langfuse';

const paramsSchema = z.object({ id: z.string().uuid() });
const querySchema = z.object({
  range: z.enum(['24h', '7d', '30d']).default('7d'),
  limit: z.coerce.number().int().min(10).max(200).default(100),
});

const ranges = {
  '24h': { interval: '24 hours', bucket: 'hour' },
  '7d': { interval: '7 days', bucket: 'day' },
  '30d': { interval: '30 days', bucket: 'day' },
} as const;

export function tokensPerSecond(
  outputTokens: number,
  latencyMs: number,
  timeToFirstTokenMs: number | null,
): number | null {
  const generationMs = latencyMs - (timeToFirstTokenMs ?? 0);
  if (outputTokens <= 0 || generationMs <= 0) return null;
  return (outputTokens * 1_000) / generationMs;
}

export async function keyAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireAdmin);

  app.get('/api/admin/keys/:id/analytics', async (request, reply) => {
    const parsedParams = paramsSchema.safeParse(request.params);
    const parsedQuery = querySchema.safeParse(request.query);
    if (!parsedParams.success || !parsedQuery.success) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: 'Key ID 或查询范围无效。' },
      });
    }
    const { id } = parsedParams.data;
    const { range, limit } = parsedQuery.data;
    const rangeConfig = ranges[range];
    const pool = getPool();
    const keyResult = await pool.query(
      `SELECT k.id, k.name, k.key_prefix AS "keyPrefix", k.status,
              k.budget_usd::float8 AS "budgetUsd", k.spend_usd::float8 AS "spendUsd",
              k.rpm_limit AS "rpmLimit", k.expires_at AS "expiresAt",
              k.last_used_at AS "lastUsedAt", k.created_at AS "createdAt",
              k.langfuse_config_ciphertext AS "langfuseConfigCiphertext",
              p.id AS "providerConnectionId", p.name AS "providerName", p.provider
         FROM virtual_api_keys k
         LEFT JOIN provider_connections p ON p.id = k.provider_connection_id
        WHERE k.id = $1`,
      [id],
    );
    const keyRow = keyResult.rows[0];
    if (!keyRow) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Key 不存在。' } });
    }

    const [summary, series, models, endpoints, errors, logs, prices] = await Promise.all([
      pool.query(
        `WITH scope AS (
           SELECT * FROM usage_logs
            WHERE virtual_api_key_id = $1 AND created_at >= now() - $2::interval
         ), per_minute AS (
           SELECT date_trunc('minute', created_at), count(*)::int AS calls
             FROM scope GROUP BY 1
         )
         SELECT count(*)::int AS calls,
                count(*) FILTER (WHERE success)::int AS "successfulCalls",
                count(*) FILTER (WHERE NOT success)::int AS "failedCalls",
                COALESCE(sum(input_tokens), 0)::float8 AS "inputTokens",
                COALESCE(sum(cached_input_tokens), 0)::float8 AS "cachedInputTokens",
                COALESCE(sum(output_tokens), 0)::float8 AS "outputTokens",
                COALESCE(sum(total_tokens), 0)::float8 AS "totalTokens",
                COALESCE(sum(cost_usd), 0)::float8 AS "costUsd",
                COALESCE(avg(cost_usd), 0)::float8 AS "averageCostUsd",
                COALESCE(avg(latency_ms), 0)::float8 AS "averageLatencyMs",
                COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms), 0)::float8 AS "p50LatencyMs",
                COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::float8 AS "p95LatencyMs",
                COALESCE(avg(time_to_first_token_ms) FILTER (WHERE time_to_first_token_ms IS NOT NULL), 0)::float8 AS "averageTtftMs",
                COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY time_to_first_token_ms)
                  FILTER (WHERE time_to_first_token_ms IS NOT NULL), 0)::float8 AS "p50TtftMs",
                COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY time_to_first_token_ms)
                  FILTER (WHERE time_to_first_token_ms IS NOT NULL), 0)::float8 AS "p95TtftMs",
                COALESCE(avg(output_tokens * 1000.0 /
                  NULLIF(latency_ms - COALESCE(time_to_first_token_ms, 0), 0))
                  FILTER (WHERE output_tokens > 0 AND latency_ms > COALESCE(time_to_first_token_ms, 0)), 0)::float8 AS "averageTps",
                COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY output_tokens * 1000.0 /
                  NULLIF(latency_ms - COALESCE(time_to_first_token_ms, 0), 0))
                  FILTER (WHERE output_tokens > 0 AND latency_ms > COALESCE(time_to_first_token_ms, 0)), 0)::float8 AS "p95Tps",
                COALESCE((SELECT max(calls) FROM per_minute), 0)::int AS "peakRpm"
           FROM scope`,
        [id, rangeConfig.interval],
      ),
      pool.query(
        `SELECT date_trunc($3, created_at) AS bucket,
                count(*)::int AS calls,
                count(*) FILTER (WHERE success)::int AS "successfulCalls",
                COALESCE(sum(total_tokens), 0)::float8 AS tokens,
                COALESCE(sum(cached_input_tokens), 0)::float8 AS "cachedTokens",
                COALESCE(sum(cost_usd), 0)::float8 AS "costUsd",
                COALESCE(avg(time_to_first_token_ms)
                  FILTER (WHERE time_to_first_token_ms IS NOT NULL), 0)::float8 AS "averageTtftMs",
                COALESCE(avg(output_tokens * 1000.0 /
                  NULLIF(latency_ms - COALESCE(time_to_first_token_ms, 0), 0))
                  FILTER (WHERE output_tokens > 0 AND latency_ms > COALESCE(time_to_first_token_ms, 0)), 0)::float8 AS "averageTps"
           FROM usage_logs
          WHERE virtual_api_key_id = $1 AND created_at >= now() - $2::interval
          GROUP BY 1 ORDER BY 1`,
        [id, rangeConfig.interval, rangeConfig.bucket],
      ),
      pool.query(
        `SELECT u.model, COALESCE(p.provider, 'unknown') AS provider,
                count(*)::int AS calls,
                count(*) FILTER (WHERE u.success)::int AS "successfulCalls",
                COALESCE(sum(u.input_tokens), 0)::float8 AS "inputTokens",
                COALESCE(sum(u.cached_input_tokens), 0)::float8 AS "cachedInputTokens",
                COALESCE(sum(u.output_tokens), 0)::float8 AS "outputTokens",
                COALESCE(sum(u.total_tokens), 0)::float8 AS "totalTokens",
                COALESCE(sum(u.cost_usd), 0)::float8 AS "costUsd",
                COALESCE(avg(u.latency_ms), 0)::float8 AS "averageLatencyMs",
                COALESCE(avg(u.output_tokens * 1000.0 /
                  NULLIF(u.latency_ms - COALESCE(u.time_to_first_token_ms, 0), 0))
                  FILTER (WHERE u.output_tokens > 0 AND u.latency_ms > COALESCE(u.time_to_first_token_ms, 0)), 0)::float8 AS "averageTps"
           FROM usage_logs u
           LEFT JOIN provider_connections p ON p.id = u.provider_connection_id
          WHERE u.virtual_api_key_id = $1 AND u.created_at >= now() - $2::interval
          GROUP BY u.model, p.provider ORDER BY calls DESC, u.model`,
        [id, rangeConfig.interval],
      ),
      pool.query(
        `SELECT endpoint, count(*)::int AS calls,
                count(*) FILTER (WHERE success)::int AS "successfulCalls",
                COALESCE(sum(total_tokens), 0)::float8 AS tokens,
                COALESCE(sum(cost_usd), 0)::float8 AS "costUsd"
           FROM usage_logs
          WHERE virtual_api_key_id = $1 AND created_at >= now() - $2::interval
          GROUP BY endpoint ORDER BY calls DESC`,
        [id, rangeConfig.interval],
      ),
      pool.query(
        `SELECT COALESCE(error_code, status_code::text) AS code, count(*)::int AS calls
           FROM usage_logs
          WHERE virtual_api_key_id = $1 AND created_at >= now() - $2::interval
            AND NOT success
          GROUP BY 1 ORDER BY calls DESC LIMIT 8`,
        [id, rangeConfig.interval],
      ),
      pool.query(
        `SELECT u.id, u.request_id AS "requestId", u.endpoint,
                u.requested_model AS "requestedModel", u.model,
                u.status_code AS "statusCode", u.success,
                u.input_tokens AS "inputTokens",
                u.cached_input_tokens AS "cachedInputTokens",
                u.output_tokens AS "outputTokens", u.total_tokens AS "totalTokens",
                u.cost_usd::float8 AS "costUsd", u.latency_ms AS "latencyMs",
                u.time_to_first_token_ms AS "timeToFirstTokenMs", u.error_code AS "errorCode",
                u.created_at AS "createdAt", p.name AS "providerName",
                (d.usage_log_id IS NOT NULL) AS "detailAvailable",
                CASE WHEN u.output_tokens > 0
                       AND u.latency_ms > COALESCE(u.time_to_first_token_ms, 0)
                  THEN u.output_tokens * 1000.0 /
                       (u.latency_ms - COALESCE(u.time_to_first_token_ms, 0))
                  ELSE NULL END::float8 AS tps
           FROM usage_logs u
           LEFT JOIN provider_connections p ON p.id = u.provider_connection_id
           LEFT JOIN usage_log_details d ON d.usage_log_id = u.id AND d.expires_at > now()
          WHERE u.virtual_api_key_id = $1 AND u.created_at >= now() - $2::interval
          ORDER BY u.created_at DESC LIMIT $3`,
        [id, rangeConfig.interval, limit],
      ),
      pool.query(
        `WITH used_models AS (
           SELECT DISTINCT COALESCE(p.provider, 'unknown') AS provider, u.model
             FROM usage_logs u
             LEFT JOIN provider_connections p ON p.id = u.provider_connection_id
            WHERE u.virtual_api_key_id = $1
           UNION
           SELECT p.provider, p.default_model
             FROM virtual_api_keys k
             JOIN provider_connections p ON p.id = k.provider_connection_id
            WHERE k.id = $1 AND p.default_model IS NOT NULL
         )
         SELECT m.provider, m.model, price.provider AS "matchedProvider",
                price.model_pattern AS "matchedPattern",
                price.input_per_million::float8 AS "inputPerMillion",
                price.cached_input_per_million::float8 AS "cachedInputPerMillion",
                price.output_per_million::float8 AS "outputPerMillion",
                price.updated_at AS "updatedAt"
           FROM used_models m
           LEFT JOIN LATERAL (
             SELECT * FROM model_prices
              WHERE provider IN (m.provider, '*')
                AND (m.model = model_pattern OR m.model LIKE model_pattern || '%')
              ORDER BY CASE WHEN provider = m.provider THEN 0 ELSE 1 END,
                       length(model_pattern) DESC
              LIMIT 1
           ) price ON true
          ORDER BY m.provider, m.model`,
        [id],
      ),
    ]);

    const { langfuseConfigCiphertext, ...key } = keyRow;
    return {
      range,
      key: {
        ...key,
        langfuse: publicLangfuseSettings(decryptLangfuseSettings(langfuseConfigCiphertext)),
      },
      summary: summary.rows[0],
      series: series.rows,
      models: models.rows,
      endpoints: endpoints.rows,
      errors: errors.rows,
      logs: logs.rows,
      prices: prices.rows,
    };
  });
}
