import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

import { propagateAttributes, startObservation } from '@langfuse/tracing';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { getProviderAdapter } from '../providers/registry';
import {
  piErrorMessage,
  piReportedCost,
  preparePiRequest,
  tokenUsageFromPi,
} from '../providers/pi-ai';
import { finalOpenAiResponse, PiOpenAiStreamSerializer } from '../providers/pi-openai';
import type { GatewayEndpoint } from '../providers/types';
import { defaultLangfuseSettings, isLangfuseDiagnosticsEnabled } from '../services/langfuse';
import {
  createKeyMiddlewareSession,
  type KeyMiddlewareResponse,
  type KeyMiddlewareSession,
} from '../services/key-middleware';
import { getProviderRuntime, type ProviderRuntime } from '../services/providers';
import { buildCurl, SseDetailCollector } from '../services/usage-details';
import { requireVirtualApiKey } from '../services/virtual-keys';
import {
  beginUsage,
  emptyUsage,
  extractTokenUsage,
  recordUsage,
  updateUsageCallStatus,
  type TokenUsage,
  type UsageCallStatus,
} from '../services/usage';

type ActiveUsageCallStatus = Extract<UsageCallStatus, 'thinking' | 'responding'>;

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

const RESERVED_UPSTREAM_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'content-type',
  'cookie',
  'host',
  'proxy-authorization',
  'transfer-encoding',
  'x-request-id',
]);
const RESERVED_RESPONSE_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'set-cookie',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const responseDecoder = new TextDecoder();
const responseEncoder = new TextEncoder();

function safeUpstreamHeaders(headers: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (
      RESERVED_UPSTREAM_HEADERS.has(name) ||
      !HEADER_NAME_PATTERN.test(name) ||
      /[\r\n]/.test(value)
    ) {
      continue;
    }
    safe[name] = value;
  }
  return safe;
}

function applyResponseHeaders(reply: FastifyReply, headers: Record<string, string>): void {
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (
      RESERVED_RESPONSE_HEADERS.has(name) ||
      !HEADER_NAME_PATTERN.test(name) ||
      /[\r\n]/.test(value)
    ) {
      continue;
    }
    reply.header(name, value);
  }
}

async function sendCompleteResponse(input: {
  reply: FastifyReply;
  middleware?: KeyMiddlewareSession;
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}): Promise<KeyMiddlewareResponse> {
  const base: KeyMiddlewareResponse = {
    status: input.status,
    headers: { 'content-type': 'application/json', ...input.headers },
    body: input.body,
    stream: false,
    phase: 'complete',
  };
  const response = input.middleware ? await input.middleware.onResponse(base) : base;
  if (input.middleware) applyResponseHeaders(input.reply, response.headers);
  else input.reply.type('application/json');
  input.reply.code(response.status).send(response.body);
  return response;
}

async function beginEventStream(input: {
  reply: FastifyReply;
  middleware?: KeyMiddlewareSession;
  requestId: string;
  status: number;
  headers?: Record<string, string>;
}): Promise<KeyMiddlewareResponse> {
  const base: KeyMiddlewareResponse = {
    status: input.status,
    headers: {
      ...input.headers,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-request-id': input.requestId,
    },
    body: null,
    stream: true,
    phase: 'headers',
  };
  const response = input.middleware ? await input.middleware.onResponse(base) : base;
  input.reply.hijack();
  input.reply.raw.statusCode = response.status;
  for (const [name, value] of Object.entries(response.headers)) {
    const normalized = name.toLowerCase();
    if (
      RESERVED_RESPONSE_HEADERS.has(normalized) ||
      !HEADER_NAME_PATTERN.test(normalized) ||
      /[\r\n]/.test(value)
    ) {
      continue;
    }
    input.reply.raw.setHeader(normalized, value);
  }
  return response;
}

async function writeResponseChunk(input: {
  reply: FastifyReply;
  middleware?: KeyMiddlewareSession;
  stream: KeyMiddlewareResponse;
  chunk: Uint8Array;
}): Promise<void> {
  if (!input.middleware) return writeChunk(input.reply, input.chunk);
  const transformed = await input.middleware.onResponse({
    ...input.stream,
    body: responseDecoder.decode(input.chunk),
    phase: 'chunk',
  });
  if (transformed.body === null || transformed.body === '') return;
  if (typeof transformed.body !== 'string') {
    throw Object.assign(new Error('流式 onResponse 必须让 ctx.response.body 保持字符串。'), {
      code: 'middleware_execution_failed',
      statusCode: 500,
    });
  }
  await writeChunk(input.reply, responseEncoder.encode(transformed.body));
}

interface PiGatewayResult {
  statusCode: number;
  model: string;
  usage: TokenUsage;
  reportedCostUsd?: number;
  errorCode?: string;
  firstTokenAt?: number;
  firstVisibleTokenAt?: number;
  traceOutput?: unknown;
  upstreamRequest?: unknown;
  upstreamResponse?: unknown;
  upstreamCurl?: string;
  capturedError?: unknown;
}

async function executePiGateway(input: {
  endpoint: GatewayEndpoint;
  body: Record<string, unknown>;
  provider: ProviderRuntime;
  requestId: string;
  signal: AbortSignal;
  reply: FastifyReply;
  middleware?: KeyMiddlewareSession;
  onStatus?: (status: ActiveUsageCallStatus) => void;
}): Promise<PiGatewayResult> {
  const prepared = preparePiRequest(
    input.endpoint,
    input.body,
    input.provider,
    input.signal,
    input.requestId,
  );
  const serializer = new PiOpenAiStreamSerializer(
    input.endpoint,
    prepared.model.id,
    prepared.includeUsageInStream,
  );
  let completedResponse: Record<string, unknown> | undefined;
  let clientCompletedResponse: unknown;
  let hasClientCompletedResponse = false;
  let usage = emptyUsage();
  let reportedCostUsd: number | undefined;
  let errorCode: string | undefined;
  let capturedError: unknown;
  let firstTokenAt: number | undefined;
  let firstVisibleTokenAt: number | undefined;
  let streamStarted = false;
  let streamResponse: KeyMiddlewareResponse | undefined;

  for await (const event of prepared.events) {
    if (event.type === 'thinking_start' || event.type === 'thinking_delta') {
      input.onStatus?.('thinking');
    } else if (
      event.type === 'text_delta' ||
      event.type === 'toolcall_delta' ||
      event.type === 'toolcall_end'
    ) {
      input.onStatus?.('responding');
    }
    const generated =
      event.type === 'text_delta' ||
      event.type === 'thinking_delta' ||
      event.type === 'toolcall_delta' ||
      event.type === 'toolcall_end';
    if (generated && !firstTokenAt) firstTokenAt = Date.now();
    if (
      (event.type === 'text_delta' ||
        event.type === 'toolcall_delta' ||
        event.type === 'toolcall_end') &&
      !firstVisibleTokenAt
    ) {
      firstVisibleTokenAt = Date.now();
    }

    if (event.type === 'done') {
      usage = tokenUsageFromPi(event.message.usage);
      reportedCostUsd = piReportedCost(event.message);
      completedResponse = finalOpenAiResponse(input.endpoint, event.message, prepared.model.id);
    } else if (event.type === 'error') {
      usage = tokenUsageFromPi(event.error.usage);
      reportedCostUsd = piReportedCost(event.error);
      errorCode = event.reason === 'aborted' ? 'client_closed_request' : 'upstream_error';
      capturedError = {
        name: event.reason === 'aborted' ? 'AbortError' : 'UpstreamError',
        code: errorCode,
        message: piErrorMessage(event),
      };
    }

    if (prepared.clientWantsStream) {
      if (event.type === 'error' && !streamStarted) continue;
      if (!streamStarted) {
        streamStarted = true;
        streamResponse = await beginEventStream({
          reply: input.reply,
          ...(input.middleware ? { middleware: input.middleware } : {}),
          requestId: input.requestId,
          status: prepared.capture.response?.status ?? 200,
          headers: prepared.capture.response?.headers ?? {},
        });
      }
      for (const chunk of serializer.feed(event)) {
        await writeResponseChunk({
          reply: input.reply,
          ...(input.middleware ? { middleware: input.middleware } : {}),
          stream: streamResponse!,
          chunk,
        });
      }
    }
  }

  let statusCode =
    streamResponse?.status ??
    (errorCode
      ? prepared.capture.response?.status && prepared.capture.response.status >= 400
        ? prepared.capture.response.status
        : errorCode === 'client_closed_request'
          ? 499
          : 502
      : (prepared.capture.response?.status ?? 200));
  if (prepared.clientWantsStream && streamStarted) {
    input.reply.raw.end();
  } else if (completedResponse) {
    const outgoing = await sendCompleteResponse({
      reply: input.reply,
      ...(input.middleware ? { middleware: input.middleware } : {}),
      status: statusCode,
      headers: prepared.capture.response?.headers ?? {},
      body: completedResponse,
    });
    statusCode = outgoing.status;
    clientCompletedResponse = outgoing.body;
    hasClientCompletedResponse = true;
  } else if (!input.reply.sent && !input.reply.raw.headersSent) {
    const outgoing = await sendCompleteResponse({
      reply: input.reply,
      ...(input.middleware ? { middleware: input.middleware } : {}),
      status: statusCode,
      headers: prepared.capture.response?.headers ?? {},
      body: {
        error: {
          type: 'api_error',
          code: errorCode ?? 'invalid_upstream_response',
          message:
            capturedError && typeof capturedError === 'object'
              ? (capturedError as Record<string, unknown>).message
              : 'Upstream stream ended without a completed response.',
        },
      },
    });
    statusCode = outgoing.status;
  }

  const capturedRequest = prepared.capture.request;
  const upstreamCurl = capturedRequest
    ? buildCurl({
        url: capturedRequest.url,
        body:
          capturedRequest.body && typeof capturedRequest.body === 'object'
            ? (capturedRequest.body as Record<string, unknown>)
            : {},
        authorization: '<UPSTREAM_CREDENTIAL>',
        method: capturedRequest.method,
        headers: capturedRequest.headers,
        accept: 'text/event-stream',
        requestId: input.requestId,
      })
    : undefined;
  return {
    statusCode,
    model: prepared.model.id,
    usage,
    ...(reportedCostUsd === undefined ? {} : { reportedCostUsd }),
    ...(errorCode ? { errorCode } : {}),
    ...(firstTokenAt ? { firstTokenAt } : {}),
    ...(firstVisibleTokenAt ? { firstVisibleTokenAt } : {}),
    ...(completedResponse
      ? {
          traceOutput: outputForTrace(
            hasClientCompletedResponse ? clientCompletedResponse : completedResponse,
          ),
        }
      : {}),
    ...(capturedRequest ? { upstreamRequest: capturedRequest } : {}),
    upstreamResponse: {
      status: prepared.capture.response?.status ?? statusCode,
      headers: prepared.capture.response?.headers ?? {},
      body: completedResponse ?? capturedError ?? null,
    },
    ...(upstreamCurl ? { upstreamCurl } : {}),
    ...(capturedError ? { capturedError } : {}),
  };
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

  let body =
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
  let reportedCostUsd: number | undefined;
  let statusCode = 500;
  let errorCode: string | undefined;
  let firstTokenAt: number | undefined;
  let firstVisibleTokenAt: number | undefined;
  let traceOutput: unknown;
  let upstreamCurl: string | undefined;
  let upstreamRequest: unknown;
  let upstreamResponse: unknown;
  let capturedError: unknown;
  let middlewareSession: KeyMiddlewareSession | undefined;
  let middlewareUpstreamHeaders: Record<string, string> = {};
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
  try {
    await beginUsage({
      requestId,
      virtualApiKeyId: key.id,
      endpoint,
      requestedModel,
    });
  } catch (usageError) {
    request.log.error({ err: usageError, requestId }, 'Failed to start gateway usage record');
  }
  let activeCallStatus: Extract<UsageCallStatus, 'processing' | ActiveUsageCallStatus> =
    'processing';
  const advanceCallStatus = (nextStatus: ActiveUsageCallStatus) => {
    const rank: Record<Extract<UsageCallStatus, 'processing' | ActiveUsageCallStatus>, number> = {
      processing: 0,
      thinking: 1,
      responding: 2,
    };
    if (rank[nextStatus] <= rank[activeCallStatus]) return;
    activeCallStatus = nextStatus;
    void updateUsageCallStatus(requestId, nextStatus).catch((usageError: unknown) => {
      request.log.error(
        { err: usageError, requestId, callStatus: nextStatus },
        'Failed to update gateway usage status',
      );
    });
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

    if (key.middlewareCode) {
      middlewareSession = await createKeyMiddlewareSession({
        code: key.middlewareCode,
        metadata: {
          key: {
            id: key.id,
            name: key.name,
            prefix: key.keyPrefix,
            budgetUsd: key.budgetUsd,
            spendUsd: key.spendUsd,
            rpmLimit: key.rpmLimit,
            provider: {
              id: provider.id,
              name: provider.name,
              slug: provider.provider,
              authType: provider.authType,
              apiMode: provider.apiMode,
              baseUrl: provider.baseUrl,
              defaultModel: provider.defaultModel,
            },
          },
          endpoint,
          requestId,
        },
        logger: (level, values) => {
          request.log[level](
            { component: 'key-middleware', apiKeyId: key.id, requestId },
            values.join(' '),
          );
        },
      });
      const transformedRequest = await middlewareSession.onRequest({
        method: request.method,
        url: clientUrl,
        headers: { ...request.headers },
        body,
        upstreamHeaders: {},
      });
      body = transformedRequest.body;
      middlewareUpstreamHeaders = safeUpstreamHeaders(transformedRequest.upstreamHeaders);
    }

    const abortController = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) abortController.abort();
    });

    if (provider.authType === 'api_key') {
      const piResult = await executePiGateway({
        endpoint,
        body,
        provider: {
          ...provider,
          headers: { ...provider.headers, ...middlewareUpstreamHeaders },
        },
        requestId,
        signal: abortController.signal,
        reply,
        ...(middlewareSession ? { middleware: middlewareSession } : {}),
        onStatus: advanceCallStatus,
      });
      model = piResult.model;
      statusCode = piResult.statusCode;
      usage = piResult.usage;
      reportedCostUsd = piResult.reportedCostUsd;
      errorCode = piResult.errorCode;
      firstTokenAt = piResult.firstTokenAt;
      firstVisibleTokenAt = piResult.firstVisibleTokenAt;
      traceOutput = piResult.traceOutput;
      upstreamCurl = piResult.upstreamCurl;
      upstreamRequest = piResult.upstreamRequest;
      upstreamResponse = piResult.upstreamResponse;
      capturedError = piResult.capturedError;
      observation.update({
        model,
        modelParameters: langfuseModelParameters(body),
        metadata: {
          requestedModel,
          actualModel: model,
          provider: provider.provider,
          providerConnectionId: provider.id,
          upstreamRuntime: 'pi-ai',
        },
      });
    } else {
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
        ...provider.headers,
        ...middlewareUpstreamHeaders,
        authorization: provider.authorization,
        'content-type': 'application/json',
        accept: prepared.body.stream === true ? 'text/event-stream' : 'application/json',
        'x-request-id': requestId,
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
        let streamResponse: KeyMiddlewareResponse | undefined;
        if (prepared.clientWantsStream) {
          streamResponse = await beginEventStream({
            reply,
            ...(middlewareSession ? { middleware: middlewareSession } : {}),
            requestId,
            status: upstream.status,
            headers: Object.fromEntries(upstream.headers.entries()),
          });
          statusCode = streamResponse.status;
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
            if (bridge.hasVisibleOutput) advanceCallStatus('responding');
            else if (bridge.hasGeneratedOutput) advanceCallStatus('thinking');
            if (prepared.clientWantsStream) {
              for (const chunk of clientChunks) {
                await writeResponseChunk({
                  reply,
                  ...(middlewareSession ? { middleware: middlewareSession } : {}),
                  stream: streamResponse!,
                  chunk,
                });
              }
            }
          }
        }
        detailCollector.feed(new Uint8Array(), true);
        const finalChunks = bridge.feed(new Uint8Array(), true);
        if (prepared.clientWantsStream) {
          for (const chunk of finalChunks) {
            await writeResponseChunk({
              reply,
              ...(middlewareSession ? { middleware: middlewareSession } : {}),
              stream: streamResponse!,
              chunk,
            });
          }
        }
        usage = bridge.usage;
        errorCode = bridge.errorCode;
        traceOutput = outputForTrace(bridge.completedResponse);
        upstreamResponse = {
          status: upstream.status,
          headers: Object.fromEntries(upstream.headers.entries()),
          body: detailCollector.snapshot(),
        };

        if (prepared.clientWantsStream) {
          reply.raw.end();
        } else if (bridge.completedResponse) {
          const outgoing = await sendCompleteResponse({
            reply,
            ...(middlewareSession ? { middleware: middlewareSession } : {}),
            status: upstream.status,
            headers: Object.fromEntries(upstream.headers.entries()),
            body: bridge.completedResponse,
          });
          statusCode = outgoing.status;
          traceOutput = outputForTrace(outgoing.body);
        } else {
          statusCode = upstream.ok ? 502 : upstream.status;
          errorCode = errorCode ?? 'invalid_upstream_response';
          const outgoing = await sendCompleteResponse({
            reply,
            ...(middlewareSession ? { middleware: middlewareSession } : {}),
            status: statusCode,
            headers: Object.fromEntries(upstream.headers.entries()),
            body: {
              error: {
                type: 'api_error',
                code: errorCode,
                message: upstream.ok
                  ? 'Upstream stream ended without a completed response.'
                  : 'Upstream stream ended with an error.',
              },
            },
          });
          statusCode = outgoing.status;
        }
      } else {
        advanceCallStatus('responding');
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
        const outgoing = await sendCompleteResponse({
          reply,
          ...(middlewareSession ? { middleware: middlewareSession } : {}),
          status: upstream.status,
          headers: Object.fromEntries(upstream.headers.entries()),
          body: transformedPayload,
        });
        statusCode = outgoing.status;
        errorCode = errorCodeFromPayload(outgoing.body) ?? errorCode;
        traceOutput = outputForTrace(outgoing.body);
      }
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
    } else if (reply.raw.headersSent && !reply.raw.writableEnded) {
      reply.raw.end();
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
        ...(reportedCostUsd === undefined ? {} : { reportedCostUsd }),
        metadata: { providerAuthType: provider?.authType ?? null },
        details: {
          gatewayCurl,
          ...(request.routerApiToken ? { routerApiToken: request.routerApiToken } : {}),
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
          ...(usage.reasoningTokens === null ? {} : { output_reasoning: usage.reasoningTokens }),
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
      if (middlewareSession) {
        try {
          await middlewareSession.dispose();
        } catch (disposeError) {
          request.log.warn(
            { err: disposeError, apiKeyId: key.id, requestId },
            'Failed to dispose API Key middleware worker',
          );
        }
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
