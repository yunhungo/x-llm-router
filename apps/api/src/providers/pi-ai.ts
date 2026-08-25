import { randomUUID } from 'node:crypto';

import {
  lazyApi,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type ThinkingLevel,
  type Tool,
  type Usage,
} from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';

import type { ProviderRuntime } from '../services/providers';
import type { TokenUsage } from '../services/usage';
import type { GatewayEndpoint } from './types';

const providers = builtinProviders();
const providersById = new Map(providers.map((provider) => [provider.id, provider]));
const customApis = {
  'openai-completions': lazyApi(() => import('@earendil-works/pi-ai/api/openai-completions')),
  'openai-responses': lazyApi(() => import('@earendil-works/pi-ai/api/openai-responses')),
};

const EMPTY_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function apiEndpoint(api: string): GatewayEndpoint | undefined {
  if (api === 'openai-completions') return 'chat.completions';
  if (
    api === 'openai-responses' ||
    api === 'azure-openai-responses' ||
    api === 'openai-codex-responses'
  ) {
    return 'responses';
  }
  return undefined;
}

function providerModels(provider: Provider): Model<Api>[] {
  try {
    return [...provider.getModels()];
  } catch {
    return [];
  }
}

export interface PiProviderDefinition {
  id: string;
  name: string;
  defaultApiBaseUrl: string;
  defaultModel: null;
  defaultApiMode: GatewayEndpoint;
  models: string[];
  capabilities: {
    upstreamApis: GatewayEndpoint[];
    gatewayApis: GatewayEndpoint[];
    supportsOAuth: boolean;
  };
}

function definitionFor(provider: Provider): PiProviderDefinition | undefined {
  const models = providerModels(provider);
  if (!provider.baseUrl || !provider.auth.apiKey || models.length === 0) return undefined;
  const upstreamApis = [
    ...new Set(models.map((model) => apiEndpoint(model.api)).filter(Boolean)),
  ] as GatewayEndpoint[];
  return {
    id: provider.id,
    name: provider.name,
    defaultApiBaseUrl: provider.baseUrl.replace(/\/$/, ''),
    defaultModel: null,
    defaultApiMode: upstreamApis[0] ?? 'chat.completions',
    models: models.map((model) => model.id).sort((left, right) => left.localeCompare(right)),
    capabilities: {
      upstreamApis,
      gatewayApis: ['responses', 'chat.completions'],
      supportsOAuth: provider.id === 'openai',
    },
  };
}

export function piProviderCatalog(): PiProviderDefinition[] {
  const builtins = providers
    .map(definitionFor)
    .filter((provider): provider is PiProviderDefinition => Boolean(provider))
    .sort((left, right) => left.name.localeCompare(right.name));
  builtins.push({
    id: 'custom',
    name: 'Custom OpenAI Compatible',
    defaultApiBaseUrl: '',
    defaultModel: null,
    defaultApiMode: 'chat.completions',
    models: [],
    capabilities: {
      upstreamApis: ['responses', 'chat.completions'],
      gatewayApis: ['responses', 'chat.completions'],
      supportsOAuth: false,
    },
  });
  return builtins;
}

export function getPiProviderDefinition(id: string): PiProviderDefinition | undefined {
  return piProviderCatalog().find((provider) => provider.id === id);
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const record = part as Record<string, unknown>;
      return typeof record.text === 'string' ? record.text : '';
    })
    .join('');
}

function imageFromPart(
  part: Record<string, unknown>,
): { type: 'image'; data: string; mimeType: string } | null {
  const imageUrl = part.image_url;
  const url =
    typeof imageUrl === 'string'
      ? imageUrl
      : imageUrl && typeof imageUrl === 'object'
        ? (imageUrl as Record<string, unknown>).url
        : part.image;
  if (typeof url !== 'string') return null;
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  return match ? { type: 'image', mimeType: match[1]!, data: match[2]! } : null;
}

function userContent(
  content: unknown,
):
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const result: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  > = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    if (typeof record.text === 'string') result.push({ type: 'text', text: record.text });
    const image = imageFromPart(record);
    if (image) result.push(image);
  }
  return result;
}

function emptyPiUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { ...EMPTY_COST, total: 0 },
  };
}

function assistantMessage(record: Record<string, unknown>, model: string): AssistantMessage {
  const content: AssistantMessage['content'] = [];
  const reasoning = record.reasoning_content ?? record.reasoning;
  if (typeof reasoning === 'string' && reasoning)
    content.push({ type: 'thinking', thinking: reasoning });
  const text = textFromContent(record.content);
  if (text) content.push({ type: 'text', text });
  const toolCalls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
  for (const rawToolCall of toolCalls) {
    if (!rawToolCall || typeof rawToolCall !== 'object') continue;
    const toolCall = rawToolCall as Record<string, unknown>;
    const fn =
      toolCall.function && typeof toolCall.function === 'object'
        ? (toolCall.function as Record<string, unknown>)
        : {};
    let args: Record<string, unknown> = {};
    try {
      if (typeof fn.arguments === 'string')
        args = JSON.parse(fn.arguments) as Record<string, unknown>;
      else if (fn.arguments && typeof fn.arguments === 'object')
        args = fn.arguments as Record<string, unknown>;
    } catch {
      args = {};
    }
    content.push({
      type: 'toolCall',
      id: typeof toolCall.id === 'string' ? toolCall.id : `call_${randomUUID()}`,
      name: typeof fn.name === 'string' ? fn.name : 'unknown_tool',
      arguments: args,
    });
  }
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'xrouter-client',
    model,
    usage: emptyPiUsage(),
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function chatContext(body: Record<string, unknown>, model: string): Context {
  const messages: Message[] = [];
  const system: string[] = [];
  const toolNames = new Map<string, string>();
  for (const raw of Array.isArray(body.messages) ? body.messages : []) {
    if (!raw || typeof raw !== 'object') continue;
    const message = raw as Record<string, unknown>;
    const role = message.role;
    if (role === 'system' || role === 'developer') {
      const text = textFromContent(message.content);
      if (text) system.push(text);
    } else if (role === 'user') {
      messages.push({ role: 'user', content: userContent(message.content), timestamp: Date.now() });
    } else if (role === 'assistant') {
      const assistant = assistantMessage(message, model);
      for (const part of assistant.content) {
        if (part.type === 'toolCall') toolNames.set(part.id, part.name);
      }
      messages.push(assistant);
    } else if (role === 'tool') {
      const toolCallId =
        typeof message.tool_call_id === 'string' ? message.tool_call_id : `call_${randomUUID()}`;
      messages.push({
        role: 'toolResult',
        toolCallId,
        toolName:
          typeof message.name === 'string' ? message.name : (toolNames.get(toolCallId) ?? 'tool'),
        content: [{ type: 'text', text: textFromContent(message.content) }],
        isError: false,
        timestamp: Date.now(),
      });
    }
  }
  return { ...(system.length ? { systemPrompt: system.join('\n\n') } : {}), messages };
}

function responsesContext(body: Record<string, unknown>, model: string): Context {
  const instructions = typeof body.instructions === 'string' ? body.instructions : undefined;
  if (typeof body.input === 'string') {
    return {
      ...(instructions ? { systemPrompt: instructions } : {}),
      messages: [{ role: 'user', content: body.input, timestamp: Date.now() }],
    };
  }
  const messages: Message[] = [];
  for (const raw of Array.isArray(body.input) ? body.input : []) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (item.type === 'function_call') {
      let args: Record<string, unknown> = {};
      try {
        if (typeof item.arguments === 'string')
          args = JSON.parse(item.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id:
              typeof item.call_id === 'string'
                ? item.call_id
                : typeof item.id === 'string'
                  ? item.id
                  : `call_${randomUUID()}`,
            name: typeof item.name === 'string' ? item.name : 'tool',
            arguments: args,
          },
        ],
        api: 'openai-responses',
        provider: 'xrouter-client',
        model,
        usage: emptyPiUsage(),
        stopReason: 'toolUse',
        timestamp: Date.now(),
      });
      continue;
    }
    if (item.type === 'function_call_output') {
      messages.push({
        role: 'toolResult',
        toolCallId: typeof item.call_id === 'string' ? item.call_id : `call_${randomUUID()}`,
        toolName: 'tool',
        content: [{ type: 'text', text: textFromContent(item.output) }],
        isError: false,
        timestamp: Date.now(),
      });
      continue;
    }
    const role = item.role;
    if (role === 'user') {
      messages.push({ role: 'user', content: userContent(item.content), timestamp: Date.now() });
    } else if (role === 'assistant') {
      messages.push(assistantMessage(item, model));
    }
  }
  return { ...(instructions ? { systemPrompt: instructions } : {}), messages };
}

function toolsFromBody(body: Record<string, unknown>): Tool[] | undefined {
  const tools: Tool[] = [];
  for (const raw of Array.isArray(body.tools) ? body.tools : []) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const fn =
      record.type === 'function' && record.function && typeof record.function === 'object'
        ? (record.function as Record<string, unknown>)
        : record;
    if (typeof fn.name !== 'string') continue;
    tools.push({
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: (fn.parameters && typeof fn.parameters === 'object'
        ? fn.parameters
        : { type: 'object', properties: {} }) as Tool['parameters'],
    });
  }
  return tools.length ? tools : undefined;
}

function thinkingLevel(body: Record<string, unknown>): ThinkingLevel | undefined {
  const raw =
    typeof body.reasoning_effort === 'string'
      ? body.reasoning_effort
      : body.reasoning && typeof body.reasoning === 'object'
        ? (body.reasoning as Record<string, unknown>).effort
        : undefined;
  return ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(raw))
    ? (raw as ThinkingLevel)
    : undefined;
}

function resolveModel(
  runtime: ProviderRuntime,
  requestedModel: string,
): { provider?: Provider; model: Model<Api> } {
  const provider = providersById.get(runtime.provider);
  const candidates = provider ? providerModels(provider) : [];
  const exact = candidates.find((candidate) => candidate.id === requestedModel);
  const desiredApi = runtime.apiMode === 'responses' ? 'openai-responses' : 'openai-completions';
  const template =
    exact ?? candidates.find((candidate) => candidate.api === desiredApi) ?? candidates[0];
  if (template) {
    return {
      ...(provider ? { provider } : {}),
      model: {
        ...template,
        id: requestedModel,
        name: exact?.name ?? requestedModel,
        baseUrl: runtime.baseUrl,
      },
    };
  }
  return {
    model: {
      id: requestedModel,
      name: requestedModel,
      provider: runtime.provider,
      api: desiredApi,
      baseUrl: runtime.baseUrl,
      reasoning: true,
      input: ['text', 'image'],
      cost: EMPTY_COST,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    },
  };
}

export interface PiRequestCapture {
  request?: { method: string; url: string; headers: Record<string, string>; body: unknown };
  response?: { status: number; headers: Record<string, string> };
}

export interface PreparedPiRequest {
  model: Model<Api>;
  clientWantsStream: boolean;
  includeUsageInStream: boolean;
  capture: PiRequestCapture;
  events: AssistantMessageEventStream;
}

export function preparePiRequest(
  endpoint: GatewayEndpoint,
  body: Record<string, unknown>,
  runtime: ProviderRuntime,
  signal: AbortSignal,
  requestId: string,
): PreparedPiRequest {
  const requestedModel =
    typeof body.model === 'string' && body.model ? body.model : runtime.defaultModel;
  if (!requestedModel) {
    throw Object.assign(
      new Error('A model is required and the selected provider has no default model.'),
      { statusCode: 400, code: 'model_required' },
    );
  }
  const { provider, model } = resolveModel(runtime, requestedModel);
  const capture: PiRequestCapture = {};
  let payload: unknown;
  const captureFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = request?.url ?? String(input);
    const headers = new Headers(request?.headers);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    capture.request = {
      method: init?.method ?? request?.method ?? 'POST',
      url,
      headers: Object.fromEntries(headers.entries()),
      body: payload,
    };
    const response = await fetch(input, init);
    capture.response = {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
    };
    return response;
  };
  const sameWireProtocol = apiEndpoint(model.api) === endpoint;
  const samplingParams = Object.fromEntries(
    Object.entries(body).filter(
      ([key]) =>
        ![
          'model',
          'messages',
          'input',
          'instructions',
          'tools',
          'tool_choice',
          'stream',
          'stream_options',
          'temperature',
          'max_tokens',
          'max_completion_tokens',
          'max_output_tokens',
          'reasoning_effort',
          'reasoning',
        ].includes(key),
    ),
  );
  const reasoning = thinkingLevel(body);
  const rawMaxTokens = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens;
  const apiKey = runtime.apiKey ?? runtime.authorization.replace(/^Bearer\s+/i, '');
  const supportsCustomFetch = !['google-generative-ai', 'google-vertex'].includes(model.api);
  const options: SimpleStreamOptions = {
    signal,
    apiKey,
    ...(supportsCustomFetch ? { fetch: captureFetch } : {}),
    headers: { 'x-request-id': requestId, ...runtime.headers },
    maxRetries: 0,
    sessionId: requestId,
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof rawMaxTokens === 'number' ? { maxTokens: rawMaxTokens } : {}),
    ...(Object.keys(samplingParams).length ? { samplingParams } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(body.tool_choice === 'none' ? { toolChoice: 'none' as const } : {}),
    onPayload: (piPayload) => {
      const next =
        sameWireProtocol && piPayload && typeof piPayload === 'object'
          ? {
              ...(piPayload as Record<string, unknown>),
              ...body,
              model: model.id,
              stream: true,
              ...(endpoint === 'chat.completions'
                ? {
                    stream_options: {
                      ...(body.stream_options && typeof body.stream_options === 'object'
                        ? (body.stream_options as Record<string, unknown>)
                        : {}),
                      include_usage: true,
                    },
                  }
                : {}),
            }
          : piPayload;
      payload = next;
      capture.request = {
        method: 'POST',
        url: runtime.baseUrl,
        headers: { 'x-request-id': requestId, ...runtime.headers },
        body: next,
      };
      return next;
    },
    onResponse: (response) => {
      capture.response = response;
    },
  };
  const context =
    endpoint === 'responses' ? responsesContext(body, model.id) : chatContext(body, model.id);
  const tools = toolsFromBody(body);
  if (tools) context.tools = tools;
  const stream = provider
    ? provider.streamSimple(model, context, options)
    : customApis[model.api as keyof typeof customApis].streamSimple(model, context, options);
  return {
    model,
    clientWantsStream: body.stream === true,
    includeUsageInStream:
      body.stream === true &&
      Boolean(
        body.stream_options &&
        typeof body.stream_options === 'object' &&
        (body.stream_options as Record<string, unknown>).include_usage === true,
      ),
    capture,
    events: stream,
  };
}

export function tokenUsageFromPi(usage: Usage): TokenUsage {
  return {
    inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
    cachedInputTokens: usage.cacheRead,
    outputTokens: usage.output,
    reasoningTokens: usage.reasoning ?? null,
    totalTokens: usage.totalTokens,
  };
}

export function piReportedCost(message: AssistantMessage): number | undefined {
  const cost = message.usage.cost.total;
  return Number.isFinite(cost) && cost > 0 ? cost : undefined;
}

export function piErrorMessage(event: Extract<AssistantMessageEvent, { type: 'error' }>): string {
  return event.error.errorMessage || 'The upstream provider returned an error.';
}
