import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

import { propagateAttributes, startObservation } from '@langfuse/tracing';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { getProviderAdapter } from '../providers/registry';
import type { GatewayEndpoint } from '../providers/types';
import { defaultLangfuseSettings, isLangfuseDiagnosticsEnabled } from '../services/langfuse';
import { getProviderRuntime, type ProviderRuntime } from '../services/providers';
import { buildCurl, SseDetailCollector } from '../services/usage-details';
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

const MODEL_PARAMETER_KEYS = [
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'max_output_tokens',
  'frequency_penalty',
  'presence_penalty',
  'seed',
  'service_tier',
  'reasoning_effort',
] as const;

export function langfuseModelParameters(
  body: Record<string, unknown>,
): Record<string, string | number> {
  const parameters: Record<string, string | number> = {};
  for (const key of MODEL_PARAMETER_KEYS) {
    const value = body[key];
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
      parameters[key] = value;
    }
  }
  const reasoning = body.reasoning;
  if (reasoning && typeof reasoning === 'object') {
    const effort = (reasoning as Record<string, unknown>).effort;
    if (typeof effort === 'string') parameters['reasoning.effort'] = effort;
  }
  return parameters;
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  if (!name) return undefined;
  const value = request.headers[name.toLowerCase()];
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === 'string' && text.trim() ? text.trim().slice(0, 200) : undefined;
}

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;

export function gatewayRequestId(request: FastifyRequest): string {
  const supplied = headerValue(request, 'x-request-id');
  if (supplied && REQUEST_ID_PATTERN.test(supplied)) return supplied;
  if (!supplied && typeof request.id === 'string' && REQUEST_ID_PATTERN.test(request.id)) {
    return request.id;
  }
  return randomUUID();
}

export function langfuseRequestIdentity(
  request: FastifyRequest,
  body: Record<string, unknown>,
  settings: ReturnType<typeof defaultLangfuseSettings>,
  apiKeyId: string,
): {
  userId: string;
  userIdSource: string;
  sessionId?: string;
  sessionIdSource: string;
  clientName?: string;
} {
  const headerUserId = headerValue(request, settings.userIdHeader);
  const bodyUserId =
    typeof body.user === 'string' && body.user.trim() ? body.user.trim().slice(0, 200) : undefined;
  const sessionId = headerValue(request, settings.sessionIdHeader);
  const clientName = headerValue(request, 'user-agent')?.split(/[\s/;(]/, 1)[0];
  return {
    userId: headerUserId ?? bodyUserId ?? `api-key:${apiKeyId}`,
    userIdSource: headerUserId
      ? `header:${settings.userIdHeader}`
      : bodyUserId
        ? 'body.user'
        : 'api-key',
    ...(sessionId ? { sessionId } : {}),
    sessionIdSource: sessionId ? `header:${settings.sessionIdHeader}` : 'none',
    ...(clientName ? { clientName } : {}),
  };
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
  const requestId = gatewayRequestId(request);
  reply.header('x-request-id', requestId);

  const body =
    request.body && typeof request.body === 'object'
      ? ({ ...request.body } as Record<string, unknown>)
      : {};
  const requestedModel =
    typeof body.model === 'string' && body.model ? body.model : '(provider default)';
  const clientUrl = `${request.protocol}://${request.headers.host ?? request.hostname}${request.url}`;
  const clientRequest = {
    method: request.method,
    url: clientUrl,
    headers: request.headers,
    body,
  };
  const gatewayCurl = buildCurl({
    url: clientUrl,
    body,
    authorization: '<ROUTER_API_KEY>',
    method: request.method,
    headers: request.headers,
    accept: body.stream === true ? 'text/event-stream' : 'application/json',
    requestId,
  });
  let provider: ProviderRuntime | undefined;
  let model = typeof body.model === 'string' ? body.model : '';
  let usage: TokenUsage = emptyUsage();
  let statusCode = 500;
  let errorCode: string | undefined;
  let firstTokenAt: number | undefined;
  let firstVisibleTokenAt: number | undefined;
  let traceOutput: unknown;
  let upstreamCurl: string | undefined;
  let upstreamRequest: unknown;
  let upstreamResponse: unknown;
  let capturedError: unknown;
  const langfuse = key.langfuse ?? defaultLangfuseSettings();
  const langfuseDiagnostics = langfuse.enabled && isLangfuseDiagnosticsEnabled();
  const identity = langfuseRequestIdentity(request, body, langfuse, key.id);
  const traceName = langfuse.traceName || `route-${endpoint}`;
  const traceMetadata = {
    ...langfuse.metadata,
    requestId,
    apiKey: key.name,
    apiKeyId: key.id,
    endpoint,
    userIdSource: identity.userIdSource,
    sessionIdSource: identity.sessionIdSource,
    ...(identity.clientName ? { clientName: identity.clientName } : {}),
  };

  const observation = propagateAttributes(
    {
      traceName,
      userId: identity.userId,
      ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
      tags: [...new Set(['gateway', endpoint, ...langfuse.tags])],
      environment: langfuse.environment,
      ...(langfuse.version ? { version: langfuse.version } : {}),
      metadata: traceMetadata,
    },
    () =>
      startObservation(
        'generate-response',
        {
          input: langfuse.captureInput ? body : { model: requestedModel, endpoint },
          model: requestedModel,
          modelParameters: langfuseModelParameters(body),
          metadata: { ...traceMetadata, requestedModel },
        },
        { asType: 'generation' },
      ),
  );
  if (langfuseDiagnostics) {
    request.log.info(
      {
        component: 'langfuse',
        event: 'observation_started',
        apiKeyId: key.id,
        requestId,
        endpoint,
        traceId: observation.traceId,
        observationId: observation.id,
      },
      'Langfuse observation started',
    );
  }

  try {
    provider = await getProviderRuntime(key.providerConnectionId, requestId, endpoint);
    const adapter = getProviderAdapter(provider.provider);
    const prepared = adapter.prepareRequest(endpoint, body, provider);
    model = String(prepared.body.model);
    observation.update({
      model,
      modelParameters: langfuseModelParameters(prepared.body),
      metadata: {
        requestedModel,
        actualModel: model,
        provider: provider.provider,
        providerConnectionId: provider.id,
      },
    });
    const upstreamUrl = `${provider.baseUrl}${prepared.path}`;
    const upstreamHeaders = {
      authorization: provider.authorization,
      'content-type': 'application/json',
      accept: prepared.body.stream === true ? 'text/event-stream' : 'application/json',
      'x-request-id': requestId,
      ...provider.headers,
    };
    upstreamRequest = {
      method: 'POST',
      url: upstreamUrl,
      headers: upstreamHeaders,
      body: prepared.body,
    };
    upstreamCurl = buildCurl({
      url: upstreamUrl,
      body: prepared.body,
      authorization: '<UPSTREAM_CREDENTIAL>',
      method: 'POST',
      headers: upstreamHeaders,
      accept: upstreamHeaders.accept,
      requestId,
    });
    const abortController = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) abortController.abort();
    });

    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(prepared.body),
      signal: abortController.signal,
    });
    statusCode = upstream.status;
    const contentType = upstream.headers.get('content-type') ?? 'application/json';
    const upstreamIsEventStream =
      contentType.toLowerCase().includes('text/event-stream') ||
      (prepared.expectsSseOnSuccess && upstream.ok);

    if (upstreamIsEventStream) {
      const bridge = adapter.createStreamBridge(prepared);
      const detailCollector = new SseDetailCollector();
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
          detailCollector.feed(value);
          const clientChunks = bridge.feed(value);
          if (!firstTokenAt && bridge.hasGeneratedOutput) firstTokenAt = Date.now();
          if (!firstVisibleTokenAt && bridge.hasVisibleOutput) firstVisibleTokenAt = Date.now();
          if (prepared.clientWantsStream) {
            for (const chunk of clientChunks) await writeChunk(reply, chunk);
          }
        }
      }
      detailCollector.feed(new Uint8Array(), true);
      const finalChunks = bridge.feed(new Uint8Array(), true);
      if (prepared.clientWantsStream) {
        for (const chunk of finalChunks) await writeChunk(reply, chunk);
      }
      usage = bridge.usage;
      errorCode = bridge.errorCode;
      traceOutput = bridge.completedResponse;
      upstreamResponse = {
        status: upstream.status,
        headers: Object.fromEntries(upstream.headers.entries()),
        body: detailCollector.snapshot(),
      };

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
      upstreamResponse = {
        status: upstream.status,
        headers: Object.fromEntries(upstream.headers.entries()),
        body: payload,
      };
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
    capturedError = { name: typed.name, code: errorCode, message: typed.message };
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
        requestedModel,
        model: model || 'unknown',
        statusCode,
        usage,
        latencyMs,
        ...(firstTokenAt ? { timeToFirstTokenMs: firstTokenAt - startedAt } : {}),
        ...(firstVisibleTokenAt
          ? { timeToFirstVisibleTokenMs: firstVisibleTokenAt - startedAt }
          : {}),
        ...(errorCode ? { errorCode } : {}),
        metadata: { providerAuthType: provider?.authType ?? null },
        details: {
          gatewayCurl,
          ...(upstreamCurl ? { upstreamCurl } : {}),
          clientRequest,
          ...(upstreamRequest !== undefined ? { upstreamRequest } : {}),
          ...(upstreamResponse !== undefined ? { upstreamResponse } : {}),
          ...(capturedError !== undefined ? { error: capturedError } : {}),
        },
      });
      observation.update({
        output: langfuse.captureOutput ? traceOutput : { statusCode, success: statusCode < 400 },
        model: model || requestedModel,
        ...(firstTokenAt ? { completionStartTime: new Date(firstTokenAt) } : {}),
        usageDetails: {
          input: usage.inputTokens,
          input_cached: usage.cachedInputTokens,
          output: usage.outputTokens,
          output_reasoning: usage.reasoningTokens,
          total: usage.totalTokens,
        },
        costDetails: { total: recorded.costUsd },
        metadata: {
          statusCode,
          latencyMs,
          timeToFirstTokenMs: firstTokenAt ? firstTokenAt - startedAt : null,
          timeToFirstVisibleTokenMs: firstVisibleTokenAt ? firstVisibleTokenAt - startedAt : null,
          errorCode: errorCode ?? '',
        },
        ...(statusCode >= 400
          ? { level: 'ERROR' as const, statusMessage: errorCode ?? `HTTP ${statusCode}` }
          : {}),
      });
    } catch (recordError) {
      request.log.error({ err: recordError, requestId }, 'Failed to record gateway usage');
      observation.update({
        level: 'ERROR',
        statusMessage: 'Failed to persist local usage record.',
      });
    } finally {
      observation.end();
      if (langfuseDiagnostics) {
        request.log.info(
          {
            component: 'langfuse',
            event: 'observation_ended',
            apiKeyId: key.id,
            requestId,
            endpoint,
            traceId: observation.traceId,
            observationId: observation.id,
            statusCode,
            errorCode: errorCode ?? null,
          },
          'Langfuse observation ended',
        );
      }
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
