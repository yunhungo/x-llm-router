import '@fastify/jwt';
import 'fastify';

import type { VirtualApiKeyRecord } from '../services/virtual-keys';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; username: string };
    user: { sub: string; username: string };
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    routerKey?: VirtualApiKeyRecord;
    routerApiToken?: string;
  }
}
