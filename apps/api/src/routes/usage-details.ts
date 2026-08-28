import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getPool } from '../db/client';
import { requireAdmin } from '../lib/admin-auth';
import { decryptJson } from '../lib/crypto';
import { mergeStoredSseSnapshot } from '../services/sse';
import {
  buildStoredRequestCurl,
  buildStoredRequestJavaScript,
  prepareStoredRequest,
} from '../services/usage-details';

const paramsSchema = z.object({ id: z.string().uuid() });
const copyQuerySchema = z.object({
  scope: z.enum(['client', 'upstream']),
  format: z.enum(['curl', 'javascript']),
});

export async function usageDetailRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireAdmin);

  app.get('/api/admin/usage/logs/:id/detail', async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: '调用记录 ID 无效。' },
      });
    }
    const result = await getPool().query(
      `SELECT u.id, u.request_id AS "requestId", u.endpoint,
              u.requested_model AS "requestedModel", u.model AS "upstreamModel",
              u.created_at AS "createdAt",
              d.gateway_curl AS "gatewayCurl", d.upstream_curl AS "upstreamCurl",
              d.client_request AS "clientRequest", d.upstream_request AS "upstreamRequest",
              d.upstream_response AS "upstreamResponse", d.error,
              d.captured_at AS "capturedAt", d.expires_at AS "expiresAt"
         FROM usage_logs u
         LEFT JOIN usage_log_details d
           ON d.usage_log_id = u.id AND d.expires_at > now()
        WHERE u.id = $1`,
      [parsed.data.id],
    );
    const row = result.rows[0];
    if (!row) {
      return reply.code(404).send({
        error: { code: 'not_found', message: '调用记录不存在。' },
      });
    }
    if (!row.gatewayCurl) {
      return {
        detail: null,
        expired: new Date(row.createdAt).getTime() <= Date.now() - 30 * 24 * 60 * 60 * 1_000,
      };
    }
    const clientRequest = prepareStoredRequest(row.clientRequest);
    const upstreamRequest = prepareStoredRequest(row.upstreamRequest);
    const upstreamResponse =
      row.upstreamResponse &&
      typeof row.upstreamResponse === 'object' &&
      !Array.isArray(row.upstreamResponse)
        ? {
            ...row.upstreamResponse,
            body: mergeStoredSseSnapshot(row.upstreamResponse.body),
          }
        : row.upstreamResponse;
    return {
      detail: {
        ...row,
        clientRequest,
        upstreamRequest,
        upstreamResponse,
        gatewayCurl:
          buildStoredRequestCurl(clientRequest, '<ROUTER_API_KEY>', row.requestId) ??
          row.gatewayCurl,
        upstreamCurl:
          buildStoredRequestCurl(upstreamRequest, '<UPSTREAM_CREDENTIAL>', row.requestId) ??
          row.upstreamCurl,
      },
      expired: false,
    };
  });

  app.get('/api/admin/usage/logs/:id/detail/curl-with-key', async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: '调用记录 ID 无效。' },
      });
    }
    const result = await getPool().query(
      `SELECT u.request_id AS "requestId", d.client_request AS "clientRequest",
              d.router_api_token_ciphertext AS "routerApiTokenCiphertext"
         FROM usage_logs u
         JOIN usage_log_details d
           ON d.usage_log_id = u.id AND d.expires_at > now()
        WHERE u.id = $1`,
      [parsed.data.id],
    );
    const row = result.rows[0];
    if (!row) {
      return reply.code(404).send({
        error: { code: 'not_found', message: '调用明细不存在或已过期。' },
      });
    }
    if (!row.routerApiTokenCiphertext) {
      return reply.code(409).send({
        error: { code: 'credential_unavailable', message: '该历史调用未保留 API Key。' },
      });
    }
    const clientRequest = prepareStoredRequest(row.clientRequest);
    const routerApiToken = decryptJson<string>(row.routerApiTokenCiphertext);
    const curl = buildStoredRequestCurl(clientRequest, routerApiToken, row.requestId);
    if (!curl) {
      return reply.code(409).send({
        error: { code: 'request_unavailable', message: '该调用无法生成 CURL。' },
      });
    }
    return { curl };
  });

  app.get('/api/admin/usage/logs/:id/detail/copy-with-key', async (request, reply) => {
    const parsedParams = paramsSchema.safeParse(request.params);
    const parsedQuery = copyQuerySchema.safeParse(request.query);
    if (!parsedParams.success || !parsedQuery.success) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: '复制请求参数无效。' },
      });
    }
    const result = await getPool().query(
      `SELECT u.request_id AS "requestId",
              d.client_request AS "clientRequest",
              d.upstream_request AS "upstreamRequest",
              d.router_api_token_ciphertext AS "routerApiTokenCiphertext",
              d.upstream_api_token_ciphertext AS "upstreamApiTokenCiphertext"
         FROM usage_logs u
         JOIN usage_log_details d
           ON d.usage_log_id = u.id AND d.expires_at > now()
        WHERE u.id = $1`,
      [parsedParams.data.id],
    );
    const row = result.rows[0];
    if (!row) {
      return reply.code(404).send({
        error: { code: 'not_found', message: '调用明细不存在或已过期。' },
      });
    }
    const { scope, format } = parsedQuery.data;
    const ciphertext =
      scope === 'client' ? row.routerApiTokenCiphertext : row.upstreamApiTokenCiphertext;
    if (!ciphertext) {
      return reply.code(409).send({
        error: { code: 'credential_unavailable', message: '该历史调用未保留 API Key。' },
      });
    }
    const storedRequest = prepareStoredRequest(
      scope === 'client' ? row.clientRequest : row.upstreamRequest,
    );
    const apiToken = decryptJson<string>(ciphertext);
    const content =
      format === 'curl'
        ? buildStoredRequestCurl(storedRequest, apiToken, row.requestId)
        : buildStoredRequestJavaScript(storedRequest, apiToken);
    if (!content) {
      return reply.code(409).send({
        error: { code: 'request_unavailable', message: '该调用无法生成请求代码。' },
      });
    }
    return { content };
  });
}
