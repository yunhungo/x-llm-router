import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getPool } from '../../db/client';

const usageLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function adminUsageRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/usage/summary', async () => {
    const [summary, series, models] = await Promise.all([
      getPool().query(
        `SELECT count(*)::int AS calls,
                count(*) FILTER (WHERE success)::int AS "successfulCalls",
                COALESCE(sum(input_tokens), 0)::int AS "inputTokens",
                COALESCE(sum(output_tokens), 0)::int AS "outputTokens",
                COALESCE(sum(cost_usd), 0)::float8 AS "costUsd",
                COALESCE(avg(latency_ms), 0)::int AS "averageLatencyMs"
           FROM usage_logs
          WHERE created_at >= now() - interval '24 hours'
            AND call_status IN ('completed', 'failed')`,
      ),
      getPool().query(
        `WITH days AS (
           SELECT generate_series(current_date - interval '13 days', current_date, interval '1 day')::date AS day
         )
         SELECT to_char(days.day, 'YYYY-MM-DD') AS bucket,
                count(u.id)::int AS calls,
                COALESCE(sum(u.total_tokens), 0)::int AS tokens,
                COALESCE(sum(u.cost_usd), 0)::float8 AS "costUsd"
           FROM days LEFT JOIN usage_logs u ON u.created_at >= days.day
            AND u.created_at < days.day + interval '1 day'
            AND u.call_status IN ('completed', 'failed')
          GROUP BY days.day ORDER BY days.day`,
      ),
      getPool().query(
        `SELECT model, count(*)::int AS calls, COALESCE(sum(total_tokens), 0)::int AS tokens,
                COALESCE(sum(cost_usd), 0)::float8 AS "costUsd"
           FROM usage_logs
          WHERE created_at >= now() - interval '30 days'
            AND call_status IN ('completed', 'failed')
          GROUP BY model ORDER BY calls DESC LIMIT 8`,
      ),
    ]);
    return { summary: summary.rows[0], series: series.rows, models: models.rows };
  });

  app.get('/api/admin/usage/logs', async (request) => {
    const query = usageLogQuerySchema.parse(request.query);
    const result = await getPool().query(
      `SELECT u.id, u.request_id AS "requestId", u.endpoint,
              u.requested_model AS "requestedModel", u.model,
              u.call_status AS "callStatus", u.status_code AS "statusCode",
              u.success, u.input_tokens AS "inputTokens",
              u.cached_input_tokens AS "cachedInputTokens", u.output_tokens AS "outputTokens",
              u.reasoning_tokens AS "reasoningTokens",
              CASE WHEN u.reasoning_tokens IS NULL THEN NULL
                ELSE GREATEST(u.output_tokens - u.reasoning_tokens, 0) END AS "visibleOutputTokens",
              u.total_tokens AS "totalTokens", u.cost_usd::float8 AS "costUsd",
              u.latency_ms AS "latencyMs", u.time_to_first_token_ms AS "timeToFirstTokenMs",
              u.time_to_first_visible_token_ms AS "timeToFirstVisibleTokenMs",
              u.error_code AS "errorCode", u.created_at AS "createdAt",
              k.id AS "apiKeyId", k.name AS "apiKeyName", p.name AS "providerName",
              (d.usage_log_id IS NOT NULL) AS "detailAvailable"
         FROM usage_logs u
         LEFT JOIN virtual_api_keys k ON k.id = u.virtual_api_key_id
         LEFT JOIN provider_connections p ON p.id = u.provider_connection_id
         LEFT JOIN usage_log_details d ON d.usage_log_id = u.id AND d.expires_at > now()
        ORDER BY u.created_at DESC LIMIT $1`,
      [query.limit],
    );
    return { logs: result.rows };
  });
}
