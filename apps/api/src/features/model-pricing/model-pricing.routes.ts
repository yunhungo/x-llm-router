import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { modelPriceInputSchema, modelPriceKeySchema } from '@x-router/contracts';

import { requireAdmin } from '../../lib/admin-auth';
import {
  ModelPriceKeyNotFoundError,
  ModelPriceNotFoundError,
  modelPricingService,
} from './model-pricing.service';

const modelPriceParamsSchema = z.object({ id: z.string().uuid() });

function keyId(request: FastifyRequest): string | undefined {
  const parsed = modelPriceParamsSchema.safeParse(request.params);
  return parsed.success ? parsed.data.id : undefined;
}

function handleModelPricingError(error: unknown, reply: FastifyReply) {
  if (error instanceof ModelPriceKeyNotFoundError) {
    return reply.code(404).send({
      error: { code: 'key_not_found', message: error.message },
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

  app.get('/api/admin/keys/:id/model-prices', async (request, reply) => {
    const id = keyId(request);
    if (!id) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: 'API Key ID 无效。' },
      });
    }
    try {
      return await modelPricingService.list(id);
    } catch (error) {
      return handleModelPricingError(error, reply);
    }
  });

  app.put('/api/admin/keys/:id/model-prices', async (request, reply) => {
    const id = keyId(request);
    const parsed = modelPriceInputSchema.safeParse(request.body);
    if (!id || !parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'invalid_request',
          message: id ? parsed.error?.issues[0]?.message : 'API Key ID 无效。',
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

  app.delete('/api/admin/keys/:id/model-prices', async (request, reply) => {
    const id = keyId(request);
    const parsed = modelPriceKeySchema.safeParse(request.body);
    if (!id || !parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'invalid_request',
          message: id ? parsed.error?.issues[0]?.message : 'API Key ID 无效。',
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
