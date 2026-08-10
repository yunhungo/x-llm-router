import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  createApiKeySchema,
  createProviderApiKeySchema,
  langfuseSettingsSchema,
} from '@x-router/contracts';

import { getConfig } from '../config';
import { getPool } from '../db/client';
import { adminId, requireAdmin } from '../lib/admin-auth';
import { encryptJson } from '../lib/crypto';
import {
  currentLangfuseSettings,
  publicLangfuseSettings,
  saveLangfuseSettings,
} from '../services/langfuse';
import { pollDeviceFlow, startDeviceFlow } from '../services/openai-oauth';
import { createApiKeyRecord } from '../services/virtual-keys';

const oauthStartSchema = z.object({ name: z.string().trim().min(1).max(120) });
const providerUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  defaultModel: z.string().trim().max(120).nullable().optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
});
const priceSchema = z.object({
  modelPattern: z.string().trim().min(1).max(120),
  inputPerMillion: z.number().nonnegative(),
  outputPerMillion: z.number().nonnegative(),
});

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireAdmin);

  app.get('/api/admin/providers', async () => {
    const result = await getPool().query(
      `SELECT id, name, provider, auth_type AS "authType", status, account_id AS "accountId",
              base_url AS "baseUrl", default_model AS "defaultModel", priority,
              token_expires_at AS "tokenExpiresAt", last_error AS "lastError",
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM provider_connections ORDER BY priority ASC, created_at ASC`,
    );
    return { providers: result.rows };
  });

  app.post('/api/admin/providers/api-key', async (request, reply) => {
    const parsed = createProviderApiKeySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: parsed.error.issues[0]?.message } });
    }
    const id = randomUUID();
    await getPool().query(
      `INSERT INTO provider_connections(
        id, name, provider, auth_type, credentials_ciphertext, base_url,
        default_model, priority, created_by
      ) VALUES ($1,$2,'openai','api_key',$3,$4,$5,$6,$7)`,
      [
        id,
        parsed.data.name,
        encryptJson({ apiKey: parsed.data.apiKey }),
        parsed.data.baseUrl ?? getConfig().OPENAI_API_BASE,
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
              p.name AS "providerName", p.id AS "providerConnectionId"
         FROM virtual_api_keys k
         LEFT JOIN provider_connections p ON p.id = k.provider_connection_id
        ORDER BY k.created_at DESC`,
    );
    return { keys: result.rows };
  });

  app.post('/api/admin/keys', async (request, reply) => {
    const parsed = createApiKeySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: parsed.error.issues[0]?.message } });
    }
    const created = await createApiKeyRecord({
      name: parsed.data.name,
      rpmLimit: parsed.data.rpmLimit,
      createdBy: adminId(request),
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
      `SELECT u.id, u.request_id AS "requestId", u.endpoint, u.model, u.status_code AS "statusCode",
              u.success, u.input_tokens AS "inputTokens", u.output_tokens AS "outputTokens",
              u.total_tokens AS "totalTokens", u.cost_usd::float8 AS "costUsd",
              u.latency_ms AS "latencyMs", u.time_to_first_token_ms AS "timeToFirstTokenMs",
              u.error_code AS "errorCode", u.created_at AS "createdAt",
              k.name AS "apiKeyName", p.name AS "providerName"
         FROM usage_logs u
         LEFT JOIN virtual_api_keys k ON k.id = u.virtual_api_key_id
         LEFT JOIN provider_connections p ON p.id = u.provider_connection_id
        ORDER BY u.created_at DESC LIMIT $1`,
      [query.limit],
    );
    return { logs: result.rows };
  });

  app.get('/api/admin/settings/langfuse', async () => ({
    settings: publicLangfuseSettings(currentLangfuseSettings()),
  }));

  app.put('/api/admin/settings/langfuse', async (request, reply) => {
    const parsed = langfuseSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: parsed.error.issues[0]?.message } });
    }
    await saveLangfuseSettings(
      {
        enabled: parsed.data.enabled,
        publicKey: parsed.data.publicKey,
        baseUrl: parsed.data.baseUrl,
        environment: parsed.data.environment,
        captureInput: parsed.data.captureInput,
        captureOutput: parsed.data.captureOutput,
        ...(parsed.data.secretKey !== undefined ? { secretKey: parsed.data.secretKey } : {}),
      },
      adminId(request),
    );
    return { ok: true, restartRequired: true };
  });

  app.get('/api/admin/settings/model-prices', async () => {
    const result = await getPool().query(
      `SELECT model_pattern AS "modelPattern", input_per_million::float8 AS "inputPerMillion",
              output_per_million::float8 AS "outputPerMillion", updated_at AS "updatedAt"
         FROM model_prices ORDER BY model_pattern`,
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
      `INSERT INTO model_prices(model_pattern, input_per_million, output_per_million, updated_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (model_pattern) DO UPDATE SET
         input_per_million = EXCLUDED.input_per_million,
         output_per_million = EXCLUDED.output_per_million,
         updated_at = now()`,
      [parsed.data.modelPattern, parsed.data.inputPerMillion, parsed.data.outputPerMillion],
    );
    return { ok: true };
  });
}
