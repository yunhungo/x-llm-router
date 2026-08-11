import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getPool } from '../db/client';
import { requireAdmin } from '../lib/admin-auth';

const paramsSchema = z.object({ id: z.string().uuid() });

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
    return { detail: row, expired: false };
  });
}
