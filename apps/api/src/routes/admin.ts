import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  createApiKeySchema,
  createProviderApiKeySchema,
  langfuseSettingsSchema,
} from '@x-router/contracts';

import { getPool } from '../db/client';
import { adminId, requireAdmin } from '../lib/admin-auth';
import { encryptJson } from '../lib/crypto';
import { getProviderAdapter, providerCatalog } from '../providers/registry';
import {
  decryptLangfuseSettings,
  defaultLangfuseSettings,
  publicLangfuseSettings,
  saveApiKeyLangfuseSettings,
  testApiKeyLangfuseConnection,
} from '../services/langfuse';
import { pollDeviceFlow, startDeviceFlow } from '../services/openai-oauth';
import { refreshProviderModels } from '../services/providers';
import { createApiKeyRecord } from '../services/virtual-keys';

const oauthStartSchema = z.object({ name: z.string().trim().min(1).max(120) });
const providerParamsSchema = z.object({ id: z.string().uuid() });
const providerUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  defaultModel: z.string().trim().max(120).nullable().optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
});
const apiKeyUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    rpmLimit: z.number().int().min(0).max(100_000).optional(),
    budgetUsd: z.number().nonnegative().nullable().optional(),
    expiresAt: z.string().datetime().nullable().optional(),
    providerConnectionId: z.string().uuid().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: '至少提供一个可更新字段。',
  });
const priceSchema = z.object({
  provider: z.string().trim().min(1).max(40).default('*'),
  modelPattern: z.string().trim().min(1).max(120),
  inputPerMillion: z.number().nonnegative(),
  cachedInputPerMillion: z.number().nonnegative(),
  outputPerMillion: z.number().nonnegative(),
});

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireAdmin);

  app.get('/api/admin/providers', async () => {
    const result = await getPool().query(
      `SELECT id, name, provider, auth_type AS "authType", status, account_id AS "accountId",
              api_mode AS "apiMode", base_url AS "baseUrl", default_model AS "defaultModel", priority,
              token_expires_at AS "tokenExpiresAt", last_error AS "lastError",
              available_models AS models, models_refreshed_at AS "modelsRefreshedAt",
              models_refresh_error AS "modelsRefreshError",
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM provider_connections ORDER BY priority ASC, created_at ASC`,
    );
    return { providers: result.rows };
  });

  app.get('/api/admin/provider-catalog', async () => ({ providers: providerCatalog() }));

  app.post('/api/admin/providers/api-key', async (request, reply) => {
    const parsed = createProviderApiKeySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: parsed.error.issues[0]?.message } });
    }
    try {
      getProviderAdapter(parsed.data.provider);
    } catch (error) {
      const typed = error as Error & { code?: string };
      return reply.code(400).send({
        error: { code: typed.code ?? 'unsupported_provider', message: typed.message },
      });
    }
    const id = randomUUID();
    await getPool().query(
      `INSERT INTO provider_connections(
        id, name, provider, auth_type, api_mode, credentials_ciphertext, base_url,
        default_model, priority, created_by
      ) VALUES ($1,$2,$3,'api_key',$4,$5,$6,$7,$8,$9)`,
      [
        id,
        parsed.data.name,
        parsed.data.provider,
        parsed.data.apiMode,
        encryptJson({ apiKey: parsed.data.apiKey }),
        parsed.data.baseUrl,
        parsed.data.defaultModel ?? null,
        parsed.data.priority,
        adminId(request),
      ],
    );
    return reply.code(201).send({ id });
  });

  app.post('/api/admin/providers/oauth/start', async (request, reply) => {
    const parsed = oauthStartSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: '请输入连接名称。' } });
    }
    const flow = await startDeviceFlow({ name: parsed.data.name, createdBy: adminId(request) });
    return reply.code(201).send(flow);
  });

  app.post('/api/admin/providers/oauth/:id/poll', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const result = await pollDeviceFlow({ id, requestedBy: adminId(request) });
    return reply.code(result.status === 'pending' ? 202 : 200).send(result);
  });

  app.post('/api/admin/providers/:id/models/refresh', async (request, reply) => {
    const parsed = providerParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: '连接 ID 无效。' } });
    }
    return refreshProviderModels(parsed.data.id);
  });

  app.patch('/api/admin/providers/:id', async (request, reply) => {
    const parsed = providerUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: parsed.error.issues[0]?.message } });
    }
    const id = (request.params as { id: string }).id;
    const result = await getPool().query(
      `UPDATE provider_connections SET
         name = COALESCE($2, name),
         status = COALESCE($3, status),
         default_model = CASE WHEN $4::boolean THEN $5 ELSE default_model END,
         priority = COALESCE($6, priority),
         updated_at = now()
       WHERE id = $1
       RETURNING id`,
      [
        id,
        parsed.data.name ?? null,
        parsed.data.status ?? null,
        Object.hasOwn(parsed.data, 'defaultModel'),
        parsed.data.defaultModel ?? null,
        parsed.data.priority ?? null,
      ],
    );
    if (!result.rowCount)
      return reply.code(404).send({ error: { code: 'not_found', message: '连接不存在。' } });
    return { ok: true };
  });

  app.delete('/api/admin/providers/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const result = await getPool().query(
      'DELETE FROM provider_connections WHERE id = $1 RETURNING id',
      [id],
    );
    if (!result.rowCount)
      return reply.code(404).send({ error: { code: 'not_found', message: '连接不存在。' } });
    return reply.code(204).send();
  });

  app.get('/api/admin/keys', async () => {
    const result = await getPool().query(
      `SELECT k.id, k.name, k.key_prefix AS "keyPrefix", k.status,
              k.budget_usd::float8 AS "budgetUsd", k.spend_usd::float8 AS "spendUsd",
              k.rpm_limit AS "rpmLimit", k.expires_at AS "expiresAt",
              k.last_used_at AS "lastUsedAt", k.created_at AS "createdAt",
              k.langfuse_config_ciphertext AS "langfuseConfigCiphertext",
              p.name AS "providerName", p.id AS "providerConnectionId"
         FROM virtual_api_keys k
         LEFT JOIN provider_connections p ON p.id = k.provider_connection_id
        WHERE k.status = 'active'
        ORDER BY k.created_at DESC`,
    );
    return {
      keys: result.rows.map(({ langfuseConfigCiphertext, ...key }) => ({
        ...key,
        langfuse: publicLangfuseSettings(decryptLangfuseSettings(langfuseConfigCiphertext)),
      })),
    };
  });

  app.post('/api/admin/keys', async (request, reply) => {
    const parsed = createApiKeySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: parsed.error.issues[0]?.message } });
    }
    const langfuse = parsed.data.langfuse
      ? {
          ...defaultLangfuseSettings(),
          ...parsed.data.langfuse,
          secretKey: parsed.data.langfuse.secretKey ?? '',
        }
      : undefined;
    if (langfuse?.enabled && (!langfuse.publicKey || !langfuse.secretKey)) {
      return reply.code(400).send({
        error: {
          code: 'langfuse_credentials_required',
          message: '启用 Langfuse 需要 Public Key 和 Secret Key。',
        },
      });
    }
    const created = await createApiKeyRecord({
      name: parsed.data.name,
      rpmLimit: parsed.data.rpmLimit,
      createdBy: adminId(request),
      ...(langfuse ? { langfuse } : {}),
      ...(parsed.data.budgetUsd !== undefined ? { budgetUsd: parsed.data.budgetUsd } : {}),
      ...(parsed.data.expiresAt !== undefined ? { expiresAt: parsed.data.expiresAt } : {}),
      ...(parsed.data.providerConnectionId !== undefined
        ? { providerConnectionId: parsed.data.providerConnectionId }
        : {}),
    });
    return reply.code(201).send({ ...created, warning: '此 API Key 只会显示一次，请立即保存。' });
  });

  app.post('/api/admin/keys/:id/revoke', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const result = await getPool().query(
      `UPDATE virtual_api_keys SET status = 'revoked', revoked_at = now()
        WHERE id = $1 AND status = 'active' RETURNING id`,
      [id],
    );
    if (!result.rowCount)
      return reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'Key 不存在或已撤销。' } });
    return { ok: true };
  });

  app.patch('/api/admin/keys/:id', async (request, reply) => {
    const parsed = apiKeyUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: parsed.error.issues[0]?.message },
      });
    }
    const id = (request.params as { id: string }).id;
    if (parsed.data.providerConnectionId) {
      const provider = await getPool().query(
        `SELECT id FROM provider_connections WHERE id = $1 AND status = 'active'`,
        [parsed.data.providerConnectionId],
      );
      if (!provider.rowCount) {
        return reply.code(404).send({
          error: { code: 'provider_not_found', message: '上游连接不存在或未启用。' },
        });
      }
    }
    const updated = await getPool().query(
      `UPDATE virtual_api_keys
          SET name = CASE WHEN $2::boolean THEN $3::text ELSE name END,
              rpm_limit = CASE WHEN $4::boolean THEN $5::integer ELSE rpm_limit END,
              budget_usd = CASE WHEN $6::boolean THEN $7::numeric ELSE budget_usd END,
              expires_at = CASE WHEN $8::boolean THEN $9::timestamptz ELSE expires_at END,
              provider_connection_id = CASE
                WHEN $10::boolean THEN $11::uuid ELSE provider_connection_id
              END
        WHERE id = $1 AND status = 'active'
        RETURNING id`,
      [
        id,
        Object.hasOwn(parsed.data, 'name'),
        parsed.data.name ?? null,
        Object.hasOwn(parsed.data, 'rpmLimit'),
        parsed.data.rpmLimit ?? null,
        Object.hasOwn(parsed.data, 'budgetUsd'),
        parsed.data.budgetUsd ?? null,
        Object.hasOwn(parsed.data, 'expiresAt'),
        parsed.data.expiresAt ?? null,
        Object.hasOwn(parsed.data, 'providerConnectionId'),
        parsed.data.providerConnectionId ?? null,
      ],
    );
    if (!updated.rowCount) {
      return reply.code(404).send({
        error: { code: 'not_found', message: 'API Key 不存在或已撤销。' },
      });
    }
    return { ok: true };
  });

  app.put('/api/admin/keys/:id/langfuse', async (request, reply) => {
    const parsed = langfuseSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: parsed.error.issues[0]?.message } });
    }
    const id = (request.params as { id: string }).id;
    const updated = await saveApiKeyLangfuseSettings(id, {
      enabled: parsed.data.enabled,
      publicKey: parsed.data.publicKey,
      baseUrl: parsed.data.baseUrl,
      environment: parsed.data.environment,
      traceName: parsed.data.traceName,
      version: parsed.data.version,
      tags: parsed.data.tags,
      metadata: parsed.data.metadata,
      userIdHeader: parsed.data.userIdHeader,
      sessionIdHeader: parsed.data.sessionIdHeader,
      captureInput: parsed.data.captureInput,
      captureOutput: parsed.data.captureOutput,
      ...(parsed.data.secretKey !== undefined ? { secretKey: parsed.data.secretKey } : {}),
    });
    if (!updated)
      return reply.code(404).send({ error: { code: 'not_found', message: 'Key 不存在。' } });
    return { ok: true, restartRequired: false };
  });

  app.post(
    '/api/admin/keys/:id/langfuse/test',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = langfuseSettingsSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: { code: 'invalid_request', message: parsed.error.issues[0]?.message } });
      }
      const id = (request.params as { id: string }).id;
      const result = await testApiKeyLangfuseConnection(id, {
        enabled: parsed.data.enabled,
        publicKey: parsed.data.publicKey,
        baseUrl: parsed.data.baseUrl,
        environment: parsed.data.environment,
        traceName: parsed.data.traceName,
        version: parsed.data.version,
        tags: parsed.data.tags,
        metadata: parsed.data.metadata,
        userIdHeader: parsed.data.userIdHeader,
        sessionIdHeader: parsed.data.sessionIdHeader,
        captureInput: parsed.data.captureInput,
        captureOutput: parsed.data.captureOutput,
        ...(parsed.data.secretKey !== undefined ? { secretKey: parsed.data.secretKey } : {}),
      });
      if (!result) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Key 不存在。' } });
      }
      return result;
    },
  );

  app.get('/api/admin/usage/summary', async () => {
    const [summary, series, models] = await Promise.all([
      getPool().query(
        `SELECT count(*)::int AS calls,
                count(*) FILTER (WHERE success)::int AS "successfulCalls",
                COALESCE(sum(input_tokens), 0)::int AS "inputTokens",
                COALESCE(sum(output_tokens), 0)::int AS "outputTokens",
                COALESCE(sum(cost_usd), 0)::float8 AS "costUsd",
                COALESCE(avg(latency_ms), 0)::int AS "averageLatencyMs"
           FROM usage_logs WHERE created_at >= now() - interval '24 hours'`,
      ),
      getPool().query(
        `WITH days AS (
           SELECT generate_series(current_date - interval '13 days', current_date, interval '1 day')::date AS day
         )
         SELECT to_char(days.day, 'YYYY-MM-DD') AS bucket,
                count(u.id)::int AS calls,
                COALESCE(sum(u.total_tokens), 0)::int AS tokens,
                COALESCE(sum(u.cost_usd), 0)::float8 AS "costUsd"
           FROM days LEFT JOIN usage_logs u ON u.created_at >= days.day AND u.created_at < days.day + interval '1 day'
          GROUP BY days.day ORDER BY days.day`,
      ),
      getPool().query(
        `SELECT model, count(*)::int AS calls, COALESCE(sum(total_tokens), 0)::int AS tokens,
                COALESCE(sum(cost_usd), 0)::float8 AS "costUsd"
           FROM usage_logs WHERE created_at >= now() - interval '30 days'
          GROUP BY model ORDER BY calls DESC LIMIT 8`,
      ),
    ]);
    return { summary: summary.rows[0], series: series.rows, models: models.rows };
  });

  app.get('/api/admin/usage/logs', async (request) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(request.query);
    const result = await getPool().query(
      `SELECT u.id, u.request_id AS "requestId", u.endpoint,
              u.requested_model AS "requestedModel", u.model, u.status_code AS "statusCode",
              u.success, u.input_tokens AS "inputTokens",
              u.cached_input_tokens AS "cachedInputTokens", u.output_tokens AS "outputTokens",
              u.total_tokens AS "totalTokens", u.cost_usd::float8 AS "costUsd",
              u.latency_ms AS "latencyMs", u.time_to_first_token_ms AS "timeToFirstTokenMs",
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

  app.get('/api/admin/settings/model-prices', async () => {
    const result = await getPool().query(
      `SELECT provider, model_pattern AS "modelPattern",
              input_per_million::float8 AS "inputPerMillion",
              cached_input_per_million::float8 AS "cachedInputPerMillion",
              output_per_million::float8 AS "outputPerMillion", updated_at AS "updatedAt"
         FROM model_prices ORDER BY provider, model_pattern`,
    );
    return { prices: result.rows };
  });

  app.put('/api/admin/settings/model-prices', async (request, reply) => {
    const parsed = priceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: parsed.error.issues[0]?.message } });
    }
    await getPool().query(
      `INSERT INTO model_prices(
         provider, model_pattern, input_per_million, cached_input_per_million,
         output_per_million, updated_at
       ) VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (provider, model_pattern) DO UPDATE SET
         input_per_million = EXCLUDED.input_per_million,
         cached_input_per_million = EXCLUDED.cached_input_per_million,
         output_per_million = EXCLUDED.output_per_million,
         updated_at = now()`,
      [
        parsed.data.provider,
        parsed.data.modelPattern,
        parsed.data.inputPerMillion,
        parsed.data.cachedInputPerMillion,
        parsed.data.outputPerMillion,
      ],
    );
    return { ok: true };
  });
}
