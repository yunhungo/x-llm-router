import type { FastifyInstance } from 'fastify';

import { providerAdminRoutes } from '../features/providers/provider-admin.routes';
import { adminUsageRoutes } from '../features/usage/admin-usage.routes';
import { virtualKeyAdminRoutes } from '../features/virtual-keys/virtual-key-admin.routes';
import { requireAdmin } from '../lib/admin-auth';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireAdmin);

  await app.register(providerAdminRoutes);
  await app.register(virtualKeyAdminRoutes);
  await app.register(adminUsageRoutes);
}
