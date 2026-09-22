/**
 * @created 2026-08-26
 * @description 维护上游定价、货币换算及用量账本。
 * @author yunhungo
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { modelPriceInputSchema, modelPriceKeySchema } from '@x-router/contracts';

import { requireAdmin } from '../../lib/admin-auth';
import {
  ModelPriceConnectionNotFoundError,
  ModelPriceNotFoundError,
  modelPricingService,
} from './model-pricing.service';

const modelPriceParamsSchema = z.object({ id: z.string().uuid() });

function connectionId(request: FastifyRequest): string | undefined {
  const parsed = modelPriceParamsSchema.safeParse(request.params);
  return parsed.success ? parsed.data.id : undefined;
}

function handleModelPricingError(error: unknown, reply: FastifyReply) {
  if (error instanceof ModelPriceConnectionNotFoundError) {
    return reply.code(404).send({
      error: { code: 'provider_not_found', message: error.message },
    });
  }
  if (error instanceof ModelPriceNotFoundError) {
    return reply.code(404).send({
      error: { code: 'price_not_found', message: error.message },
    });
  }
  throw error;
}

export async function modelPricingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireAdmin);

  app.get('/api/admin/providers/:id/model-prices', async (request, reply) => {
    const id = connectionId(request);
    if (!id) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: '上游连接 ID 无效。' },
      });
    }
    try {
      return await modelPricingService.list(id);
    } catch (error) {
      return handleModelPricingError(error, reply);
    }
  });

  app.put('/api/admin/providers/:id/model-prices', async (request, reply) => {
    const id = connectionId(request);
    const parsed = modelPriceInputSchema.safeParse(request.body);
    if (!id || !parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'invalid_request',
          message: id ? parsed.error?.issues[0]?.message : '上游连接 ID 无效。',
        },
      });
    }
    try {
      await modelPricingService.upsert(id, parsed.data);
      return { ok: true };
    } catch (error) {
      return handleModelPricingError(error, reply);
    }
  });

  app.delete('/api/admin/providers/:id/model-prices', async (request, reply) => {
    const id = connectionId(request);
    const parsed = modelPriceKeySchema.safeParse(request.body);
    if (!id || !parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'invalid_request',
          message: id ? parsed.error?.issues[0]?.message : '上游连接 ID 无效。',
        },
      });
    }
    try {
      await modelPricingService.delete(id, parsed.data);
      return { ok: true };
    } catch (error) {
      return handleModelPricingError(error, reply);
    }
  });
}
