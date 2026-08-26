import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { createProviderApiKeySchema, updateProviderSchema } from '@x-router/contracts';

import { getPool } from '../../db/client';
import { adminId } from '../../lib/admin-auth';
import { encryptJson } from '../../lib/crypto';
import { getPiProviderDefinition } from '../../providers/pi-ai';
import { isProviderRegistered, providerCatalog } from '../../providers/registry';
import { pollDeviceFlow, startDeviceFlow } from '../../services/openai-oauth';
import { refreshProviderModels } from '../../services/providers';

const oauthStartSchema = z.object({ name: z.string().trim().min(1).max(120) });
const providerParamsSchema = z.object({ id: z.string().uuid() });

export async function providerAdminRoutes(app: FastifyInstance): Promise<void> {
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
      return reply.code(400).send({
        error: { code: 'invalid_request', message: parsed.error.issues[0]?.message },
      });
    }
    if (!isProviderRegistered(parsed.data.provider)) {
      return reply.code(400).send({
        error: {
          code: 'unsupported_provider',
          message: `Provider is not registered: ${parsed.data.provider}.`,
        },
      });
    }
    const definition = getPiProviderDefinition(parsed.data.provider);
    const models = definition?.models ?? [];
    const id = randomUUID();
    await getPool().query(
      `INSERT INTO provider_connections(
        id, name, provider, auth_type, api_mode, credentials_ciphertext, base_url,
        default_model, priority, available_models, models_refreshed_at, created_by
      ) VALUES ($1,$2,$3,'api_key',$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
      [
        id,
        parsed.data.name,
        parsed.data.provider,
        parsed.data.apiMode,
        encryptJson({ apiKey: parsed.data.apiKey }),
        parsed.data.baseUrl,
        parsed.data.defaultModel ?? null,
        parsed.data.priority,
        JSON.stringify(models),
        models.length ? new Date() : null,
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
    const params = providerParamsSchema.safeParse(request.params);
    const parsed = updateProviderSchema.safeParse(request.body);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: '连接 ID 无效。' } });
    }
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: parsed.error.issues[0]?.message },
      });
    }
    const id = params.data.id;
    const existing = await getPool().query<{ auth_type: 'oauth' | 'api_key' }>(
      'SELECT auth_type FROM provider_connections WHERE id = $1',
      [id],
    );
    const connection = existing.rows[0];
    if (!connection) {
      return reply.code(404).send({ error: { code: 'not_found', message: '连接不存在。' } });
    }
    const hasApiKeyOnlyFields = ['apiMode', 'apiKey', 'baseUrl'].some((field) =>
      Object.hasOwn(parsed.data, field),
    );
    if (connection.auth_type !== 'api_key' && hasApiKeyOnlyFields) {
      return reply.code(400).send({
        error: {
          code: 'provider_auth_type_mismatch',
          message: 'OAuth 连接不能修改 API 方式、Base URL 或 API Key。',
        },
      });
    }
    const encryptedApiKey = parsed.data.apiKey ? encryptJson({ apiKey: parsed.data.apiKey }) : null;
    const result = await getPool().query(
      `UPDATE provider_connections SET
         name = CASE WHEN $2::boolean THEN $3::text ELSE name END,
         status = CASE WHEN $4::boolean THEN $5::text ELSE status END,
         api_mode = CASE WHEN $6::boolean THEN $7::text ELSE api_mode END,
         base_url = CASE WHEN $8::boolean THEN $9::text ELSE base_url END,
         credentials_ciphertext = CASE
           WHEN $10::boolean THEN $11::text ELSE credentials_ciphertext
         END,
         default_model = CASE WHEN $12::boolean THEN $13::text ELSE default_model END,
         priority = CASE WHEN $14::boolean THEN $15::integer ELSE priority END,
         updated_at = now()
       WHERE id = $1
       RETURNING id`,
      [
        id,
        Object.hasOwn(parsed.data, 'name'),
        parsed.data.name ?? null,
        Object.hasOwn(parsed.data, 'status'),
        parsed.data.status ?? null,
        Object.hasOwn(parsed.data, 'apiMode'),
        parsed.data.apiMode ?? null,
        Object.hasOwn(parsed.data, 'baseUrl'),
        parsed.data.baseUrl ?? null,
        Object.hasOwn(parsed.data, 'apiKey'),
        encryptedApiKey,
        Object.hasOwn(parsed.data, 'defaultModel'),
        parsed.data.defaultModel ?? null,
        Object.hasOwn(parsed.data, 'priority'),
        parsed.data.priority ?? null,
      ],
    );
    if (!result.rowCount) {
      return reply.code(404).send({ error: { code: 'not_found', message: '连接不存在。' } });
    }
    return { ok: true };
  });

  app.delete('/api/admin/providers/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const result = await getPool().query(
      'DELETE FROM provider_connections WHERE id = $1 RETURNING id',
      [id],
    );
    if (!result.rowCount) {
      return reply.code(404).send({ error: { code: 'not_found', message: '连接不存在。' } });
    }
    return reply.code(204).send();
  });
}
