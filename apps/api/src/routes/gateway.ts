import { once } from 'node:events';

import { propagateAttributes, startObservation } from '@langfuse/tracing';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { getProviderAdapter } from '../providers/registry';
import type { GatewayEndpoint } from '../providers/types';
import { defaultLangfuseSettings } from '../services/langfuse';
import { getProviderRuntime, type ProviderRuntime } from '../services/providers';
import { requireVirtualApiKey } from '../services/virtual-keys';
import { emptyUsage, extractTokenUsage, recordUsage, type TokenUsage } from '../services/usage';

function errorCodeFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const error = (payload as Record<string, unknown>).error;
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as Record<string, unknown>).code;
  return code === undefined ? undefined : String(code);
}

function outputForTrace(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === 'string') return record.output_text;
  const choices = record.choices;
  if (Array.isArray(choices)) {
    return choices.map((choice) =>
      choice && typeof choice === 'object' ? (choice as Record<string, unknown>).message : choice,
    );
  }
  return record.output ?? payload;
}

async function writeChunk(reply: FastifyReply, chunk: Uint8Array): Promise<void> {
  if (!reply.raw.write(chunk)) await once(reply.raw, 'drain');
}

async function gatewayHandler(
  endpoint: GatewayEndpoint,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const startedAt = Date.now();
  const key = request.routerKey;
  if (!key) return;
  const requestId = String(request.headers['x-request-id'] ?? request.id);
  reply.header('x-request-id', requestId);

  const body =
    request.body && typeof request.body === 'object'
      ? ({ ...request.body } as Record<string, unknown>)
      : {};
  let provider: ProviderRuntime | undefined;
  let model = typeof body.model === 'string' ? body.model : '';
  let usage: TokenUsage = emptyUsage();
  let statusCode = 500;
  let errorCode: string | undefined;
  let firstTokenAt: number | undefined;
  let traceOutput: unknown;
  const langfuse = key.langfuse ?? defaultLangfuseSettings();

  const observation = propagateAttributes(
    {
      traceName: `route-${endpoint}`,
      userId: key.id,
      sessionId: String(request.headers['x-session-id'] ?? requestId),
      tags: ['gateway', endpoint],
      environment: langfuse.environment,
      metadata: { requestId, apiKey: key.name, apiKeyId: key.id },
    },
    () =>
      startObservation(
        'route-llm-request',
        {
          input: langfuse.captureInput ? body : { model, endpoint },
          model,
          metadata: { requestId, endpoint, apiKeyId: key.id },
        },
        { asType: 'generation' },
      ),
  );

  try {
    provider = await getProviderRuntime(key.providerConnectionId, requestId);
    const adapter = getProviderAdapter(provider.provider);
    const prepared = adapter.prepareRequest(endpoint, body, provider);
    model = String(prepared.body.model);
    const abortController = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) abortController.abort();
    });

    const upstream = await fetch(`${provider.baseUrl}${prepared.path}`, {
      method: 'POST',
      headers: {
        authorization: provider.authorization,
        'content-type': 'application/json',
        accept: prepared.body.stream === true ? 'text/event-stream' : 'application/json',
        'x-request-id': requestId,
        ...provider.headers,
      },
      body: JSON.stringify(prepared.body),
      signal: abortController.signal,
    });
    statusCode = upstream.status;
    const contentType = upstream.headers.get('content-type') ?? 'application/json';
    const isEventStream =
      contentType.toLowerCase().includes('text/event-stream') ||
      (prepared.expectsSseOnSuccess && upstream.ok);

    if (isEventStream) {
      const bridge = adapter.createStreamBridge(prepared);
      if (prepared.clientWantsStream) {
        reply.hijack();
        reply.raw.statusCode = upstream.status;
        reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
        reply.raw.setHeader('cache-control', 'no-cache, no-transform');
        reply.raw.setHeader('connection', 'keep-alive');
        reply.raw.setHeader('x-request-id', requestId);
      }

      if (upstream.body) {
        const reader = upstream.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!firstTokenAt && value.byteLength > 0) firstTokenAt = Date.now();
          const clientChunks = bridge.feed(value);
          if (prepared.clientWantsStream) {
            for (const chunk of clientChunks) await writeChunk(reply, chunk);
          }
        }
      }
      const finalChunks = bridge.feed(new Uint8Array(), true);
      if (prepared.clientWantsStream) {
        for (const chunk of finalChunks) await writeChunk(reply, chunk);
      }
      usage = bridge.usage;
      errorCode = bridge.errorCode;
      traceOutput = bridge.completedResponse;

      if (prepared.clientWantsStream) {
        reply.raw.end();
      } else if (bridge.completedResponse) {
        reply.code(upstream.status).type('application/json').send(bridge.completedResponse);
      } else {
        statusCode = upstream.ok ? 502 : upstream.status;
        errorCode = errorCode ?? 'invalid_upstream_response';
        reply.code(statusCode).send({
          error: {
            type: 'api_error',
            code: errorCode,
            message: upstream.ok
              ? 'Upstream stream ended without a completed response.'
              : 'Upstream stream ended with an error.',
          },
        });
      }
    } else {
      const text = await upstream.text();
      let payload: unknown;
      try {
        payload = text ? (JSON.parse(text) as unknown) : {};
      } catch {
        payload = { error: { type: 'api_error', message: text || upstream.statusText } };
      }
      const transformedPayload = adapter.transformJsonResponse(prepared, payload);
      usage = extractTokenUsage(transformedPayload);
      errorCode = errorCodeFromPayload(transformedPayload);
      traceOutput = outputForTrace(transformedPayload);
      reply.code(upstream.status).type('application/json').send(transformedPayload);
    }
  } catch (error) {
    const typed = error as Error & { statusCode?: number; code?: string };
    statusCode = typed.statusCode ?? (typed.name === 'AbortError' ? 499 : 502);
    errorCode =
      typed.code ?? (typed.name === 'AbortError' ? 'client_closed_request' : 'upstream_error');
    if (!reply.sent && !reply.raw.headersSent) {
      await reply.code(statusCode).send({
        error: { type: 'api_error', code: errorCode, message: typed.message },
      });
    }
  } finally {
    const latencyMs = Date.now() - startedAt;
    try {
      const recorded = await recordUsage({
        requestId,
        virtualApiKeyId: key.id,
        ...(provider ? { providerConnectionId: provider.id } : {}),
        ...(provider ? { provider: provider.provider } : {}),
        endpoint,
        model: model || 'unknown',
        statusCode,
        usage,
        latencyMs,
        ...(firstTokenAt ? { timeToFirstTokenMs: firstTokenAt - startedAt } : {}),
        ...(errorCode ? { errorCode } : {}),
        metadata: { providerAuthType: provider?.authType ?? null },
      });
      observation.update({
        output: langfuse.captureOutput ? traceOutput : { statusCode, success: statusCode < 400 },
        usageDetails: {
          input: usage.inputTokens,
          input_cached: usage.cachedInputTokens,
          output: usage.outputTokens,
          total: usage.totalTokens,
        },
        costDetails: { total: recorded.costUsd },
        metadata: { statusCode, latencyMs, errorCode: errorCode ?? '' },
      });
    } catch (recordError) {
      request.log.error({ err: recordError, requestId }, 'Failed to record gateway usage');
      observation.update({
        level: 'ERROR',
        statusMessage: 'Failed to persist local usage record.',
      });
    } finally {
      observation.end();
    }
  }
}

export async function gatewayRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/responses', { onRequest: requireVirtualApiKey }, async (request, reply) =>
    gatewayHandler('responses', request, reply),
  );
  app.post('/v1/chat/completions', { onRequest: requireVirtualApiKey }, async (request, reply) =>
    gatewayHandler('chat.completions', request, reply),
  );
}
