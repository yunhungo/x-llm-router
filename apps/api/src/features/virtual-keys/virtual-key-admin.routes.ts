import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { createApiKeySchema, langfuseSettingsSchema } from '@x-router/contracts';

import { getPool } from '../../db/client';
import { adminId } from '../../lib/admin-auth';
import {
  decryptLangfuseSettings,
  defaultLangfuseSettings,
  publicLangfuseSettings,
  saveApiKeyLangfuseSettings,
  testApiKeyLangfuseConnection,
} from '../../services/langfuse';
import {
  DEFAULT_KEY_MIDDLEWARE_CODE,
  validateKeyMiddlewareCode,
} from '../../services/key-middleware';
import { createApiKeyRecord } from '../../services/virtual-keys';

const apiKeyParamsSchema = z.object({ id: z.string().uuid() });
const keyMiddlewareSchema = z.object({ code: z.string().min(1).max(100_000) });
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

export async function virtualKeyAdminRoutes(app: FastifyInstance): Promise<void> {
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
      return reply.code(400).send({
        error: { code: 'invalid_request', message: parsed.error.issues[0]?.message },
      });
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
    if (!result.rowCount) {
      return reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'Key 不存在或已撤销。' } });
    }
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
      return reply.code(400).send({
        error: { code: 'invalid_request', message: parsed.error.issues[0]?.message },
      });
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
    if (!updated) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Key 不存在。' } });
    }
    return { ok: true, restartRequired: false };
  });

  app.get('/api/admin/keys/:id/middleware', async (request, reply) => {
    const params = apiKeyParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: 'Key ID 无效。' } });
    }
    const result = await getPool().query<{
      middlewareCode: string | null;
      updatedAt: string | null;
    }>(
      `SELECT middleware_code AS "middlewareCode", middleware_updated_at AS "updatedAt"
         FROM virtual_api_keys WHERE id = $1`,
      [params.data.id],
    );
    const row = result.rows[0];
    if (!row) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Key 不存在。' } });
    }
    return {
      code: row.middlewareCode ?? DEFAULT_KEY_MIDDLEWARE_CODE,
      updatedAt: row.updatedAt,
    };
  });

  app.put('/api/admin/keys/:id/middleware', async (request, reply) => {
    const params = apiKeyParamsSchema.safeParse(request.params);
    const parsed = keyMiddlewareSchema.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'invalid_request',
          message: parsed.error?.issues[0]?.message ?? 'Key ID 无效。',
        },
      });
    }
    try {
      await validateKeyMiddlewareCode(parsed.data.code);
    } catch (error) {
      return reply.code(400).send({
        error: {
          code: 'invalid_middleware',
          message: error instanceof Error ? error.message : '中间件代码无效。',
        },
      });
    }
    const result = await getPool().query<{ updatedAt: string }>(
      `UPDATE virtual_api_keys
          SET middleware_code = $2, middleware_updated_at = now()
        WHERE id = $1 AND status = 'active'
        RETURNING middleware_updated_at AS "updatedAt"`,
      [params.data.id, parsed.data.code],
    );
    const row = result.rows[0];
    if (!row) {
      return reply.code(404).send({
        error: { code: 'not_found', message: 'API Key 不存在或已撤销。' },
      });
    }
    return { ok: true, updatedAt: row.updatedAt };
  });

  app.post(
    '/api/admin/keys/:id/langfuse/test',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = langfuseSettingsSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: { code: 'invalid_request', message: parsed.error.issues[0]?.message },
        });
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
}
