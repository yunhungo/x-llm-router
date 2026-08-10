import { once } from 'node:events';

import { propagateAttributes, startObservation } from '@langfuse/tracing';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { currentLangfuseSettings } from '../services/langfuse';
import { getProviderRuntime, type ProviderRuntime } from '../services/providers';
import { requireVirtualApiKey } from '../services/virtual-keys';
import { SseAccumulator } from '../services/sse';
import { emptyUsage, extractTokenUsage, recordUsage, type TokenUsage } from '../services/usage';

type GatewayEndpoint = 'responses' | 'chat.completions';

const CHATGPT_RESPONSE_KEYS = new Set([
  'model',
  'input',
  'instructions',
  'stream',
  'store',
  'include',
  'tools',
  'tool_choice',
  'reasoning',
  'previous_response_id',
  'truncation',
]);

function buildUpstreamBody(
  body: Record<string, unknown>,
  endpoint: GatewayEndpoint,
  provider: ProviderRuntime,
): { body: Record<string, unknown>; clientWantsStream: boolean } {
  const model = typeof body.model === 'string' && body.model ? body.model : provider.defaultModel;
  if (!model) {
    throw Object.assign(
      new Error('A model is required and the selected provider has no default model.'),
      {
        statusCode: 400,
        code: 'model_required',
      },
    );
  }
  const clientWantsStream = body.stream === true;
  const normalized: Record<string, unknown> = { ...body, model };

  if (provider.authType === 'oauth' && endpoint === 'responses') {
    normalized.stream = true;
    normalized.store = false;
    const include = Array.isArray(normalized.include) ? [...normalized.include] : [];
    if (!include.includes('reasoning.encrypted_content'))
      include.push('reasoning.encrypted_content');
    normalized.include = include;
    if (!normalized.instructions) {
      normalized.instructions =
        'You are a helpful AI assistant accessed through an OpenAI-compatible router. Follow the user instructions carefully.';
    }
    return {
      clientWantsStream,
      body: Object.fromEntries(
        Object.entries(normalized).filter(([key]) => CHATGPT_RESPONSE_KEYS.has(key)),
      ),
    };
  }

  if (normalized.stream === true && endpoint === 'chat.completions') {
    const streamOptions =
      normalized.stream_options && typeof normalized.stream_options === 'object'
        ? (normalized.stream_options as Record<string, unknown>)
        : {};
    normalized.stream_options = { ...streamOptions, include_usage: true };
  }
  return { body: normalized, clientWantsStream };
}

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
  const langfuse = currentLangfuseSettings();

  const observation = propagateAttributes(
    {
      traceName: `route-${endpoint}`,
      userId: key.id,
      sessionId: String(request.headers['x-session-id'] ?? requestId),
      tags: ['gateway', endpoint],
      metadata: { requestId, apiKey: key.name },
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
    const transformed = buildUpstreamBody(body, endpoint, provider);
    model = String(transformed.body.model);
    const upstreamPath = endpoint === 'responses' ? '/responses' : '/chat/completions';
    const abortController = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) abortController.abort();
    });

    const upstream = await fetch(`${provider.baseUrl}${upstreamPath}`, {
      method: 'POST',
      headers: {
        authorization: provider.authorization,
        'content-type': 'application/json',
        accept: transformed.body.stream === true ? 'text/event-stream' : 'application/json',
        'x-request-id': requestId,
        ...provider.headers,
      },
      body: JSON.stringify(transformed.body),
      signal: abortController.signal,
    });
    statusCode = upstream.status;
    const contentType = upstream.headers.get('content-type') ?? 'application/json';

    if (contentType.toLowerCase().includes('text/event-stream')) {
      const parser = new SseAccumulator();
      const chunks: Uint8Array[] = [];
      if (transformed.clientWantsStream) {
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
          parser.feed(value);
          if (transformed.clientWantsStream) await writeChunk(reply, value);
          else chunks.push(value);
        }
      }
      parser.feed(new Uint8Array(), true);
      usage = parser.usage;
      errorCode = parser.errorCode;
      traceOutput = parser.completedResponse;

      if (transformed.clientWantsStream) {
        reply.raw.end();
      } else if (parser.completedResponse) {
        reply.code(upstream.status).type('application/json').send(parser.completedResponse);
      } else {
        const text = Buffer.concat(chunks).toString('utf8');
        statusCode = upstream.ok ? 502 : upstream.status;
        errorCode = errorCode ?? 'invalid_upstream_response';
        reply.code(statusCode).send({
          error: {
            type: 'api_error',
            code: errorCode,
            message: upstream.ok
              ? 'Upstream stream ended without a completed response.'
              : text.slice(0, 2_000),
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
      usage = extractTokenUsage(payload);
      errorCode = errorCodeFromPayload(payload);
      traceOutput = outputForTrace(payload);
      reply.code(upstream.status).type('application/json').send(payload);
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
