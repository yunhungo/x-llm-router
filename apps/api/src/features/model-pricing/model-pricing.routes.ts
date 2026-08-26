import type { FastifyInstance } from 'fastify';

import { modelPriceInputSchema, modelPriceKeySchema } from '@x-router/contracts';

import { requireAdmin } from '../../lib/admin-auth';
import { ModelPriceNotFoundError, modelPricingService } from './model-pricing.service';

export async function modelPricingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireAdmin);

  app.get('/api/admin/settings/model-prices', async () => modelPricingService.list());

  app.put('/api/admin/settings/model-prices', async (request, reply) => {
    const parsed = modelPriceInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: parsed.error.issues[0]?.message },
      });
    }
    await modelPricingService.upsert(parsed.data);
    return { ok: true };
  });

  app.delete('/api/admin/settings/model-prices', async (request, reply) => {
    const parsed = modelPriceKeySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: parsed.error.issues[0]?.message },
      });
    }
    try {
      await modelPricingService.delete(parsed.data);
      return { ok: true };
    } catch (error) {
      if (error instanceof ModelPriceNotFoundError) {
        return reply.code(404).send({
          error: { code: 'price_not_found', message: error.message },
        });
      }
      throw error;
    }
  });
}
