import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getPool } from '../../db/client';

const usageLogQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(50),
    cursor: z.string().trim().min(1).max(512).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    search: z.string().trim().min(1).max(160).optional(),
    status: z.enum(['all', 'active', 'success', 'failed']).default('all'),
    model: z.string().trim().min(1).max(120).optional(),
    endpoint: z.enum(['responses', 'chat.completions']).optional(),
    keyId: z.string().uuid().optional(),
    provider: z.string().trim().min(1).max(120).optional(),
    metric: z.enum(['recent', 'errors', 'latency', 'ttft', 'tps']).default('recent'),
    threshold: z.coerce.number().nonnegative().optional(),
  })
  .refine(
    (value) => !['latency', 'ttft', 'tps'].includes(value.metric) || value.threshold !== undefined,
    { message: '该指标筛选需要 threshold。' },
  );

const usageLogCursorSchema = z.object({
  createdAt: z.string().datetime(),
  id: z.string().uuid(),
});

type UsageLogCursor = z.infer<typeof usageLogCursorSchema>;

interface UsageLogRow {
  id: string;
  createdAt: Date | string;
  cursorCreatedAt: string;
  [key: string]: unknown;
}

interface UsageLogFacetsRow {
  models: string[];
  endpoints: string[];
}

const DEFAULT_USAGE_LOG_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

function encodeUsageLogCursor(cursor: UsageLogCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeUsageLogCursor(value: string | undefined): UsageLogCursor | null | false {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    const parsed = usageLogCursorSchema.safeParse(decoded);
    return parsed.success ? parsed.data : false;
  } catch {
    return false;
  }
}

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

  app.get('/api/admin/usage/logs', async (request, reply) => {
    const parsedQuery = usageLogQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: '调用记录分页参数无效。' },
      });
    }
    const cursor = decodeUsageLogCursor(parsedQuery.data.cursor);
    if (cursor === false) {
      return reply.code(400).send({
        error: { code: 'invalid_cursor', message: '调用记录游标无效或已损坏。' },
      });
    }
    const query = parsedQuery.data;
    const to = query.to ?? new Date().toISOString();
    const from =
      query.from ?? new Date(new Date(to).getTime() - DEFAULT_USAGE_LOG_WINDOW_MS).toISOString();
    if (new Date(from).getTime() >= new Date(to).getTime()) {
      return reply.code(400).send({
        error: { code: 'invalid_time_range', message: '开始时间必须早于结束时间。' },
      });
    }
    const pool = getPool();
    const [result, facetResult] = await Promise.all([
      pool.query<UsageLogRow>(
        `WITH scoped AS (
           SELECT u.*, k.id AS "apiKeyId", k.name AS "apiKeyName",
                  p.name AS "providerName", p.provider,
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
             LEFT JOIN virtual_api_keys k ON k.id = u.virtual_api_key_id
             LEFT JOIN provider_connections p ON p.id = u.provider_connection_id
            WHERE u.created_at >= $1::timestamptz
              AND u.created_at < $2::timestamptz
              AND ($3::timestamptz IS NULL
                OR u.created_at < $3::timestamptz
                OR (u.created_at = $3::timestamptz AND u.id < $4::uuid))
              AND ($5::text IS NULL
                OR u.request_id ILIKE '%' || $5::text || '%'
                OR u.requested_model ILIKE '%' || $5::text || '%'
                OR u.model ILIKE '%' || $5::text || '%'
                OR COALESCE(u.error_code, '') ILIKE '%' || $5::text || '%'
                OR COALESCE(u.status_code::text, '') ILIKE '%' || $5::text || '%'
                OR u.endpoint ILIKE '%' || $5::text || '%'
                OR COALESCE(k.name, '') ILIKE '%' || $5::text || '%'
                OR COALESCE(p.name, '') ILIKE '%' || $5::text || '%')
              AND ($6::text = 'all'
                OR ($6::text = 'active' AND u.call_status IN ('processing', 'thinking', 'responding'))
                OR ($6::text = 'success' AND u.success IS TRUE)
                OR ($6::text = 'failed' AND u.success IS FALSE))
              AND ($7::text IS NULL OR u.model = $7::text)
              AND ($8::text IS NULL OR u.endpoint = $8::text)
              AND ($9::uuid IS NULL OR u.virtual_api_key_id = $9::uuid)
              AND ($10::text IS NULL OR COALESCE(p.provider, 'unknown') = $10::text)
         ), filtered AS (
           SELECT * FROM scoped s
            WHERE $11::text = 'recent'
               OR ($11::text = 'errors' AND s.success IS FALSE)
               OR ($11::text = 'latency' AND s.latency_ms >= $12::float8)
               OR ($11::text = 'ttft' AND s.time_to_first_token_ms IS NOT NULL
                    AND s.time_to_first_token_ms >= $12::float8)
               OR ($11::text = 'tps' AND s.tps IS NOT NULL AND s.tps <= $12::float8)
         )
         SELECT f.id, f.request_id AS "requestId", f.endpoint,
                f.requested_model AS "requestedModel", f.model,
                f.call_status AS "callStatus", f.status_code AS "statusCode",
                f.success, f.input_tokens AS "inputTokens",
                f.cached_input_tokens AS "cachedInputTokens", f.output_tokens AS "outputTokens",
                f.reasoning_tokens AS "reasoningTokens",
                CASE WHEN f.reasoning_tokens IS NULL THEN NULL
                  ELSE GREATEST(f.output_tokens - f.reasoning_tokens, 0) END AS "visibleOutputTokens",
                f.total_tokens AS "totalTokens", f.cost_usd::float8 AS "costUsd",
                f.latency_ms AS "latencyMs", f.time_to_first_token_ms AS "timeToFirstTokenMs",
                f.time_to_first_visible_token_ms AS "timeToFirstVisibleTokenMs",
                f.error_code AS "errorCode", f.created_at AS "createdAt",
                f."apiKeyId", f."apiKeyName", f."providerName",
                f.tps, f."visibleTps",
              to_char(
                f.created_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              ) AS "cursorCreatedAt",
              (d.usage_log_id IS NOT NULL) AS "detailAvailable"
           FROM filtered f
           LEFT JOIN usage_log_details d ON d.usage_log_id = f.id AND d.expires_at > now()
          ORDER BY f.created_at DESC, f.id DESC
          LIMIT $13`,
        [
          from,
          to,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          query.search ?? null,
          query.status,
          query.model ?? null,
          query.endpoint ?? null,
          query.keyId ?? null,
          query.provider ?? null,
          query.metric,
          query.threshold ?? null,
          query.limit + 1,
        ],
      ),
      cursor
        ? Promise.resolve({ rows: [] as UsageLogFacetsRow[] })
        : pool.query<UsageLogFacetsRow>(
            `SELECT COALESCE(array_agg(DISTINCT u.model ORDER BY u.model), '{}') AS models,
                    COALESCE(array_agg(DISTINCT u.endpoint ORDER BY u.endpoint), '{}') AS endpoints
               FROM usage_logs u
              WHERE u.created_at >= $1::timestamptz
                AND u.created_at < $2::timestamptz
                AND ($3::uuid IS NULL OR u.virtual_api_key_id = $3::uuid)`,
            [from, to, query.keyId ?? null],
          ),
    ]);
    const hasMore = result.rows.length > query.limit;
    const pageRows = result.rows.slice(0, query.limit);
    const lastRow = pageRows.at(-1);
    const logs = pageRows.map(({ cursorCreatedAt: _cursorCreatedAt, ...log }) => log);
    return {
      logs,
      hasMore,
      nextCursor:
        hasMore && lastRow
          ? encodeUsageLogCursor({ createdAt: lastRow.cursorCreatedAt, id: lastRow.id })
          : null,
      facets: cursor ? undefined : (facetResult.rows[0] ?? { models: [], endpoints: [] }),
    };
  });
}
