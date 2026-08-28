import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getPool } from '../db/client';
import { requireAdmin } from '../lib/admin-auth';
import { decryptLangfuseSettings, publicLangfuseSettings } from '../services/langfuse';

const paramsSchema = z.object({ id: z.string().uuid() });
const querySchema = z.object({
  range: z.enum(['24h', '7d', '30d']).default('24h'),
  model: z.string().trim().min(1).max(120).optional(),
  provider: z.string().trim().min(1).max(40).optional(),
});
const logQuerySchema = z
  .object({
    range: z.enum(['24h', '7d', '30d']).default('24h'),
    limit: z.coerce.number().int().min(10).max(200).default(100),
    metric: z.enum(['recent', 'errors', 'latency', 'ttft', 'tps']).default('recent'),
    threshold: z.coerce.number().nonnegative().optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    model: z.string().trim().min(1).max(120).optional(),
    provider: z.string().trim().min(1).max(40).optional(),
  })
  .refine(
    (value) => !['latency', 'ttft', 'tps'].includes(value.metric) || value.threshold !== undefined,
    { message: '该指标下钻需要 threshold。' },
  );

const ranges = {
  '24h': { interval: '24 hours', bucket: '1 hour' },
  '7d': { interval: '7 days', bucket: '6 hours' },
  '30d': { interval: '30 days', bucket: '1 day' },
} as const;

export function tokensPerSecond(
  outputTokens: number,
  latencyMs: number,
  timeToFirstTokenMs: number | null,
): number | null {
  if (timeToFirstTokenMs === null) return null;
  const generationMs = latencyMs - timeToFirstTokenMs;
  if (outputTokens <= 0 || generationMs <= 0) return null;
  return (outputTokens * 1_000) / generationMs;
}

export function visibleTokensPerSecond(
  outputTokens: number,
  reasoningTokens: number | null,
  latencyMs: number,
  timeToFirstVisibleTokenMs: number | null,
): number | null {
  if (reasoningTokens === null || timeToFirstVisibleTokenMs === null) return null;
  const visibleTokens = Math.max(outputTokens - reasoningTokens, 0);
  const visibleGenerationMs = latencyMs - timeToFirstVisibleTokenMs;
  if (visibleTokens <= 0 || visibleGenerationMs <= 0) return null;
  return (visibleTokens * 1_000) / visibleGenerationMs;
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
    const { range, model, provider } = parsedQuery.data;
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

    const analytics = await Promise.all([
      pool.query(
        `WITH scope AS (
           SELECT u.*
            FROM usage_logs u
             LEFT JOIN provider_connections p ON p.id = u.provider_connection_id
            WHERE u.virtual_api_key_id = $1 AND u.created_at >= now() - $2::interval
              AND u.call_status IN ('completed', 'failed')
              AND ($3::text IS NULL OR u.model = $3::text)
              AND ($4::text IS NULL OR COALESCE(p.provider, 'unknown') = $4::text)
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
                COALESCE(sum(reasoning_tokens), 0)::float8 AS "reasoningTokens",
                COALESCE(sum(total_tokens), 0)::float8 AS "totalTokens",
                COALESCE(sum(cost_usd), 0)::float8 AS "costUsd",
                COALESCE(avg(cost_usd), 0)::float8 AS "averageCostUsd",
                COALESCE(avg(latency_ms), 0)::float8 AS "averageLatencyMs",
                COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms), 0)::float8 AS "p50LatencyMs",
                COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::float8 AS "p95LatencyMs",
                COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms), 0)::float8 AS "p99LatencyMs",
                COALESCE(avg(time_to_first_token_ms) FILTER (WHERE time_to_first_token_ms IS NOT NULL), 0)::float8 AS "averageTtftMs",
                COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY time_to_first_token_ms)
                  FILTER (WHERE time_to_first_token_ms IS NOT NULL), 0)::float8 AS "p50TtftMs",
                COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY time_to_first_token_ms)
                  FILTER (WHERE time_to_first_token_ms IS NOT NULL), 0)::float8 AS "p95TtftMs",
                COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY time_to_first_token_ms)
                  FILTER (WHERE time_to_first_token_ms IS NOT NULL), 0)::float8 AS "p99TtftMs",
                COALESCE(avg(time_to_first_visible_token_ms)
                  FILTER (WHERE time_to_first_visible_token_ms IS NOT NULL), 0)::float8 AS "averageFirstVisibleMs",
                COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY time_to_first_visible_token_ms)
                  FILTER (WHERE time_to_first_visible_token_ms IS NOT NULL), 0)::float8 AS "p50FirstVisibleMs",
                COALESCE(avg(output_tokens * 1000.0 /
                  NULLIF(latency_ms - time_to_first_token_ms, 0))
                  FILTER (WHERE output_tokens > 0 AND time_to_first_token_ms IS NOT NULL
                    AND latency_ms > time_to_first_token_ms), 0)::float8 AS "averageTps",
                COALESCE(percentile_cont(0.1) WITHIN GROUP (ORDER BY output_tokens * 1000.0 /
                  NULLIF(latency_ms - time_to_first_token_ms, 0))
                  FILTER (WHERE output_tokens > 0 AND time_to_first_token_ms IS NOT NULL
                    AND latency_ms > time_to_first_token_ms), 0)::float8 AS "p10Tps",
                COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY output_tokens * 1000.0 /
                  NULLIF(latency_ms - time_to_first_token_ms, 0))
                  FILTER (WHERE output_tokens > 0 AND time_to_first_token_ms IS NOT NULL
                    AND latency_ms > time_to_first_token_ms), 0)::float8 AS "p50Tps",
                COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY output_tokens * 1000.0 /
                  NULLIF(latency_ms - time_to_first_token_ms, 0))
                  FILTER (WHERE output_tokens > 0 AND time_to_first_token_ms IS NOT NULL
                    AND latency_ms > time_to_first_token_ms), 0)::float8 AS "p95Tps",
                COALESCE(avg((output_tokens - reasoning_tokens) * 1000.0 /
                  NULLIF(latency_ms - time_to_first_visible_token_ms, 0))
                  FILTER (WHERE reasoning_tokens IS NOT NULL
                    AND output_tokens > reasoning_tokens
                    AND time_to_first_visible_token_ms IS NOT NULL
                    AND latency_ms > time_to_first_visible_token_ms), 0)::float8 AS "averageVisibleTps",
                count(*) FILTER (WHERE time_to_first_token_ms IS NOT NULL)::int AS "streamingCalls",
                COALESCE((SELECT max(calls) FROM per_minute), 0)::int AS "peakRpm"
           FROM scope`,
        [id, rangeConfig.interval, model ?? null, provider ?? null],
      ),
      pool.query(
        `WITH bounds AS (
           SELECT date_bin($5::interval, now() - $2::interval, timestamptz '2000-01-01') AS start_at,
                  date_bin($5::interval, now(), timestamptz '2000-01-01') AS end_at
         ), buckets AS (
           SELECT generate_series(start_at, end_at, $5::interval) AS bucket FROM bounds
         ), scope AS (
           SELECT u.*, u.output_tokens * 1000.0 /
             NULLIF(u.latency_ms - u.time_to_first_token_ms, 0) AS tps
             FROM usage_logs u
             LEFT JOIN provider_connections p ON p.id = u.provider_connection_id
            WHERE u.virtual_api_key_id = $1 AND u.created_at >= now() - $2::interval
              AND u.call_status IN ('completed', 'failed')
              AND ($3::text IS NULL OR u.model = $3::text)
              AND ($4::text IS NULL OR COALESCE(p.provider, 'unknown') = $4::text)
         )
         SELECT b.bucket, b.bucket + $5::interval AS "bucketEnd",
                count(s.id)::int AS calls,
                count(s.id) FILTER (WHERE s.success)::int AS "successfulCalls",
                count(s.id) FILTER (WHERE NOT s.success)::int AS "failedCalls",
                COALESCE(sum(s.input_tokens), 0)::float8 AS "inputTokens",
                COALESCE(sum(s.output_tokens), 0)::float8 AS "outputTokens",
                COALESCE(sum(s.total_tokens), 0)::float8 AS tokens,
                COALESCE(sum(s.cached_input_tokens), 0)::float8 AS "cachedTokens",
                COALESCE(sum(s.cost_usd), 0)::float8 AS "costUsd",
                COALESCE(avg(s.latency_ms), 0)::float8 AS "averageLatencyMs",
                COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY s.latency_ms), 0)::float8 AS "p50LatencyMs",
                COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY s.latency_ms), 0)::float8 AS "p95LatencyMs",
                COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY s.latency_ms), 0)::float8 AS "p99LatencyMs",
                COALESCE(avg(s.time_to_first_token_ms)
                  FILTER (WHERE s.time_to_first_token_ms IS NOT NULL), 0)::float8 AS "averageTtftMs",
                COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY s.time_to_first_token_ms)
                  FILTER (WHERE s.time_to_first_token_ms IS NOT NULL), 0)::float8 AS "p50TtftMs",
                COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY s.time_to_first_token_ms)
                  FILTER (WHERE s.time_to_first_token_ms IS NOT NULL), 0)::float8 AS "p95TtftMs",
                COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY s.time_to_first_token_ms)
                  FILTER (WHERE s.time_to_first_token_ms IS NOT NULL), 0)::float8 AS "p99TtftMs",
                COALESCE(avg(s.tps) FILTER (WHERE s.tps > 0), 0)::float8 AS "averageTps",
                COALESCE(percentile_cont(0.1) WITHIN GROUP (ORDER BY s.tps)
                  FILTER (WHERE s.tps > 0), 0)::float8 AS "p10Tps",
                COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY s.tps)
                  FILTER (WHERE s.tps > 0), 0)::float8 AS "p50Tps"
           FROM buckets b
           LEFT JOIN scope s ON s.created_at >= b.bucket AND s.created_at < b.bucket + $5::interval
          GROUP BY b.bucket ORDER BY b.bucket`,
        [id, rangeConfig.interval, model ?? null, provider ?? null, rangeConfig.bucket],
      ),
      pool.query(
        `WITH scoped AS (
           SELECT date_bin($5::interval, u.created_at, timestamptz '2000-01-01') AS bucket,
                  COALESCE(p.provider, 'unknown') AS provider, u.model, u.success,
                  u.input_tokens, u.output_tokens, u.reasoning_tokens,
                  u.cached_input_tokens, u.cost_usd,
                  u.time_to_first_token_ms, u.latency_ms,
                  CASE WHEN u.output_tokens > 0
                         AND u.time_to_first_token_ms IS NOT NULL
                         AND u.latency_ms > u.time_to_first_token_ms
                    THEN u.output_tokens * 1000.0 /
                         (u.latency_ms - u.time_to_first_token_ms)
                    ELSE NULL END AS tps
             FROM usage_logs u
             LEFT JOIN provider_connections p ON p.id = u.provider_connection_id
            WHERE u.virtual_api_key_id = $1 AND u.created_at >= now() - $2::interval
              AND u.call_status IN ('completed', 'failed')
              AND ($3::text IS NULL OR u.model = $3::text)
              AND ($4::text IS NULL OR COALESCE(p.provider, 'unknown') = $4::text)
         )
         SELECT bucket, bucket + $5::interval AS "bucketEnd", provider, model,
                count(*)::int AS calls,
                count(*) FILTER (WHERE success)::int AS "successfulCalls",
                count(*) FILTER (WHERE NOT success)::int AS "failedCalls",
                COALESCE(sum(input_tokens), 0)::float8 AS "inputTokens",
                COALESCE(sum(output_tokens), 0)::float8 AS "outputTokens",
                COALESCE(sum(cached_input_tokens), 0)::float8 AS "cachedTokens",
                COALESCE(sum(cost_usd), 0)::float8 AS "costUsd",
                COALESCE(avg(time_to_first_token_ms)
                  FILTER (WHERE time_to_first_token_ms IS NOT NULL), 0)::float8 AS "averageTtftMs",
                COALESCE(avg(tps) FILTER (WHERE tps > 0), 0)::float8 AS "averageTps",
                COALESCE(avg(latency_ms), 0)::float8 AS "averageLatencyMs"
           FROM scoped
          GROUP BY bucket, provider, model
          ORDER BY bucket, provider, model`,
        [id, rangeConfig.interval, model ?? null, provider ?? null, rangeConfig.bucket],
      ),
      pool.query(
        `SELECT u.model, COALESCE(p.provider, 'unknown') AS provider,
                count(*)::int AS calls,
                count(*) FILTER (WHERE u.success)::int AS "successfulCalls",
                COALESCE(sum(u.input_tokens), 0)::float8 AS "inputTokens",
                COALESCE(sum(u.cached_input_tokens), 0)::float8 AS "cachedInputTokens",
                COALESCE(sum(u.output_tokens), 0)::float8 AS "outputTokens",
                COALESCE(sum(u.reasoning_tokens), 0)::float8 AS "reasoningTokens",
                COALESCE(sum(u.total_tokens), 0)::float8 AS "totalTokens",
                COALESCE(sum(u.cost_usd), 0)::float8 AS "costUsd",
                COALESCE(avg(u.latency_ms), 0)::float8 AS "averageLatencyMs",
                COALESCE(avg(u.output_tokens * 1000.0 /
                  NULLIF(u.latency_ms - u.time_to_first_token_ms, 0))
                  FILTER (WHERE u.output_tokens > 0 AND u.time_to_first_token_ms IS NOT NULL
                    AND u.latency_ms > u.time_to_first_token_ms), 0)::float8 AS "averageTps"
           FROM usage_logs u
           LEFT JOIN provider_connections p ON p.id = u.provider_connection_id
          WHERE u.virtual_api_key_id = $1 AND u.created_at >= now() - $2::interval
            AND u.call_status IN ('completed', 'failed')
            AND ($3::text IS NULL OR u.model = $3::text)
            AND ($4::text IS NULL OR COALESCE(p.provider, 'unknown') = $4::text)
          GROUP BY u.model, p.provider ORDER BY calls DESC, u.model`,
        [id, rangeConfig.interval, model ?? null, provider ?? null],
      ),
      pool.query(
        `SELECT u.endpoint, count(*)::int AS calls,
                count(*) FILTER (WHERE u.success)::int AS "successfulCalls",
                COALESCE(sum(u.total_tokens), 0)::float8 AS tokens,
                COALESCE(sum(u.cost_usd), 0)::float8 AS "costUsd"
           FROM usage_logs u
           LEFT JOIN provider_connections p ON p.id = u.provider_connection_id
          WHERE u.virtual_api_key_id = $1 AND u.created_at >= now() - $2::interval
            AND u.call_status IN ('completed', 'failed')
            AND ($3::text IS NULL OR u.model = $3::text)
            AND ($4::text IS NULL OR COALESCE(p.provider, 'unknown') = $4::text)
          GROUP BY u.endpoint ORDER BY calls DESC`,
        [id, rangeConfig.interval, model ?? null, provider ?? null],
      ),
      pool.query(
        `SELECT COALESCE(u.error_code, u.status_code::text) AS code, count(*)::int AS calls
           FROM usage_logs u
           LEFT JOIN provider_connections p ON p.id = u.provider_connection_id
          WHERE u.virtual_api_key_id = $1 AND u.created_at >= now() - $2::interval
            AND u.call_status IN ('completed', 'failed')
            AND ($3::text IS NULL OR u.model = $3::text)
            AND ($4::text IS NULL OR COALESCE(p.provider, 'unknown') = $4::text)
            AND NOT u.success
          GROUP BY 1 ORDER BY calls DESC LIMIT 8`,
        [id, rangeConfig.interval, model ?? null, provider ?? null],
      ),
      pool.query(
        `WITH used_models AS (
           SELECT DISTINCT COALESCE(p.provider, 'unknown') AS provider, u.model
             FROM usage_logs u
             LEFT JOIN provider_connections p ON p.id = u.provider_connection_id
           WHERE u.virtual_api_key_id = $1
           UNION
           SELECT p.provider, available.model
             FROM provider_connections p
             CROSS JOIN LATERAL jsonb_array_elements_text(p.available_models) AS available(model)
            WHERE p.status = 'active'
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
              WHERE (virtual_api_key_id = $1 OR virtual_api_key_id IS NULL)
                AND provider IN (m.provider, '*')
                AND (m.model = model_pattern OR m.model LIKE model_pattern || '%')
              ORDER BY CASE WHEN virtual_api_key_id = $1 THEN 0 ELSE 1 END,
                       CASE WHEN provider = m.provider THEN 0 ELSE 1 END,
                       length(model_pattern) DESC
              LIMIT 1
           ) price ON true
          ORDER BY m.provider, m.model`,
        [id],
      ),
    ]);
    const [summary, series, modelSeries, models, endpoints, errors, prices] = analytics;

    const { langfuseConfigCiphertext, ...key } = keyRow;
    return {
      range,
      key: {
        ...key,
        langfuse: publicLangfuseSettings(decryptLangfuseSettings(langfuseConfigCiphertext)),
      },
      summary: summary.rows[0],
      series: series.rows,
      modelSeries: modelSeries.rows,
      models: models.rows,
      endpoints: endpoints.rows,
      errors: errors.rows,
      prices: prices.rows,
    };
  });

  app.get('/api/admin/keys/:id/analytics/logs', async (request, reply) => {
    const parsedParams = paramsSchema.safeParse(request.params);
    const parsedQuery = logQuerySchema.safeParse(request.query);
    if (!parsedParams.success || !parsedQuery.success) {
      return reply.code(400).send({
        error: {
          code: 'invalid_request',
          message: parsedQuery.error?.issues[0]?.message ?? 'Key ID 或下钻条件无效。',
        },
      });
    }

    const { id } = parsedParams.data;
    const { range, limit, metric, threshold, from, to, model, provider } = parsedQuery.data;
    const pool = getPool();
    const exists = await pool.query('SELECT id FROM virtual_api_keys WHERE id = $1', [id]);
    if (!exists.rowCount) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Key 不存在。' } });
    }

    const result = await pool.query(
      `WITH scoped AS (
         SELECT u.*,
                CASE WHEN u.output_tokens > 0
                           AND u.time_to_first_token_ms IS NOT NULL
                           AND u.latency_ms > u.time_to_first_token_ms
                  THEN u.output_tokens * 1000.0 /
                       (u.latency_ms - u.time_to_first_token_ms)
                  ELSE NULL END::float8 AS tps,
                CASE WHEN u.reasoning_tokens IS NOT NULL
                           AND u.output_tokens > u.reasoning_tokens
                           AND u.time_to_first_visible_token_ms IS NOT NULL
                           AND u.latency_ms > u.time_to_first_visible_token_ms
                  THEN (u.output_tokens - u.reasoning_tokens) * 1000.0 /
                       (u.latency_ms - u.time_to_first_visible_token_ms)
                  ELSE NULL END::float8 AS "visibleTps"
           FROM usage_logs u
           LEFT JOIN provider_connections p ON p.id = u.provider_connection_id
          WHERE u.virtual_api_key_id = $1
            AND u.created_at >= now() - $2::interval
            AND ($3::timestamptz IS NULL OR u.created_at >= $3::timestamptz)
            AND ($4::timestamptz IS NULL OR u.created_at < $4::timestamptz)
            AND ($7::text IS NULL OR u.model = $7::text)
            AND ($8::text IS NULL OR COALESCE(p.provider, 'unknown') = $8::text)
       ), filtered AS (
         SELECT s.*, count(*) OVER()::int AS "filteredCount"
           FROM scoped s
          WHERE $5 = 'recent'
             OR ($5 = 'errors' AND NOT s.success)
             OR ($5 = 'latency' AND s.latency_ms >= $6::float8)
             OR ($5 = 'ttft' AND s.time_to_first_token_ms IS NOT NULL
                  AND s.time_to_first_token_ms >= $6::float8)
             OR ($5 = 'tps' AND s.tps IS NOT NULL AND s.tps <= $6::float8)
       )
       SELECT f.id, f.request_id AS "requestId", f.endpoint,
              f.requested_model AS "requestedModel", f.model,
              f.call_status AS "callStatus", f.status_code AS "statusCode", f.success,
              f.input_tokens AS "inputTokens", f.cached_input_tokens AS "cachedInputTokens",
              f.output_tokens AS "outputTokens", f.reasoning_tokens AS "reasoningTokens",
              CASE WHEN f.reasoning_tokens IS NULL THEN NULL
                ELSE GREATEST(f.output_tokens - f.reasoning_tokens, 0) END AS "visibleOutputTokens",
              f.total_tokens AS "totalTokens",
              f.cost_usd::float8 AS "costUsd", f.latency_ms AS "latencyMs",
              f.time_to_first_token_ms AS "timeToFirstTokenMs",
              f.time_to_first_visible_token_ms AS "timeToFirstVisibleTokenMs",
              f.error_code AS "errorCode",
              f.created_at AS "createdAt", p.name AS "providerName",
              (d.usage_log_id IS NOT NULL) AS "detailAvailable", f.tps,
              f."visibleTps", f."filteredCount"
         FROM filtered f
         LEFT JOIN provider_connections p ON p.id = f.provider_connection_id
         LEFT JOIN usage_log_details d ON d.usage_log_id = f.id AND d.expires_at > now()
        ORDER BY
          CASE WHEN $5 = 'latency' THEN f.latency_ms END DESC NULLS LAST,
          CASE WHEN $5 = 'ttft' THEN f.time_to_first_token_ms END DESC NULLS LAST,
          CASE WHEN $5 = 'tps' THEN f.tps END ASC NULLS LAST,
          f.created_at DESC
        LIMIT $9`,
      [
        id,
        ranges[range].interval,
        from ?? null,
        to ?? null,
        metric,
        threshold ?? null,
        model ?? null,
        provider ?? null,
        limit,
      ],
    );

    const total = Number(result.rows[0]?.filteredCount ?? 0);
    const logs = result.rows.map(({ filteredCount: _filteredCount, ...log }) => log);
    return {
      logs,
      total,
      query: {
        metric,
        threshold: threshold ?? null,
        from: from ?? null,
        to: to ?? null,
        model: model ?? null,
        provider: provider ?? null,
      },
    };
  });
}
