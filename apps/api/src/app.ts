import { randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import { getConfig } from './config';
import { getPool } from './db/client';
import { modelPricingRoutes } from './features/model-pricing/model-pricing.routes';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { gatewayRoutes } from './routes/gateway';
import { keyAnalyticsRoutes } from './routes/key-analytics';
import { usageDetailRoutes } from './routes/usage-details';
import { getRuntimeSecrets } from './runtime-secrets';
import { registerUsageDetailRetention } from './services/usage-details';

function normalizedOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function requestOriginAllowed(request: FastifyRequest, configuredOrigin?: string): boolean {
  const requestOrigin = request.headers.origin;
  if (!requestOrigin) return true;
  const expectedOrigin = configuredOrigin ?? `${request.protocol}://${request.host}`;
  return normalizedOrigin(requestOrigin) === normalizedOrigin(expectedOrigin);
}

export async function buildApp(): Promise<FastifyInstance> {
  const config = getConfig();
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    bodyLimit: 16 * 1024 * 1024,
    trustProxy: config.NODE_ENV === 'production',
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });

  app.setErrorHandler(async (error, request, reply) => {
    request.log.error({ err: error }, 'Unhandled request error');
    if (reply.sent) return;
    const typedError = error as Error & {
      statusCode?: number;
      code?: string;
      exposeMessage?: boolean;
    };
    const statusCode =
      typedError.statusCode && typedError.statusCode >= 400 ? typedError.statusCode : 500;
    const exposeMessage = statusCode < 500 || typedError.exposeMessage === true;
    return reply.code(statusCode).send({
      error: {
        type: statusCode >= 500 ? 'api_error' : 'invalid_request_error',
        code: typedError.code ?? 'internal_error',
        message:
          config.NODE_ENV === 'production' && !exposeMessage
            ? 'Internal server error.'
            : typedError.message,
      },
    });
  });

  await app.register(cookie);
  await app.register(jwt, {
    secret: getRuntimeSecrets().JWT_SECRET,
    cookie: { cookieName: 'xrouter_session', signed: false },
  });
  await app.register(rateLimit, { global: false });
  if (config.WEB_ORIGIN) {
    await app.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
  }
  if (config.WEB_ROOT) {
    await app.register(staticFiles, {
      root: config.WEB_ROOT,
      wildcard: false,
      maxAge: '30d',
      immutable: true,
    });
  }

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    if (
      request.url.startsWith('/api/') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      !requestOriginAllowed(request, config.WEB_ORIGIN)
    ) {
      return reply
        .code(403)
        .send({ error: { code: 'origin_rejected', message: '请求来源无效。' } });
    }
  });

  app.get('/healthz', async () => ({ status: 'ok', buildSha: config.BUILD_SHA }));
  app.get('/readyz', async (_request, reply) => {
    try {
      await getPool().query('SELECT 1');
      return { status: 'ready', buildSha: config.BUILD_SHA };
    } catch {
      return reply.code(503).send({ status: 'not_ready', buildSha: config.BUILD_SHA });
    }
  });

  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(keyAnalyticsRoutes);
  await app.register(usageDetailRoutes);
  await app.register(modelPricingRoutes);
  await app.register(gatewayRoutes);
  registerUsageDetailRetention(app);

  app.setNotFoundHandler(async (request, reply) => {
    const acceptsHtml = request.headers.accept?.includes('text/html') ?? false;
    const requestPath = request.url.split('?', 1)[0] ?? request.url;
    const reservedRoutes = ['/api', '/v1', '/healthz', '/readyz'];
    const isWebRoute = !reservedRoutes.some(
      (route) => requestPath === route || requestPath.startsWith(`${route}/`),
    );
    if (config.WEB_ROOT && ['GET', 'HEAD'].includes(request.method) && acceptsHtml && isWebRoute) {
      return reply.sendFile('index.html', { maxAge: 0, immutable: false });
    }
    return reply.code(404).send({
      error: {
        type: 'invalid_request_error',
        code: 'not_found',
        message: `Route ${request.method} ${request.url} not found.`,
      },
    });
  });

  return app;
}
