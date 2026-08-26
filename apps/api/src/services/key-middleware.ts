import { Worker } from 'node:worker_threads';

import type { GatewayEndpoint } from '../providers/types';

export const DEFAULT_KEY_MIDDLEWARE_CODE = `/**
 * 客户端请求发往上游前执行。
 *
 * ctx.request.body            请求 JSON，可直接修改
 * ctx.request.headers         客户端请求头（用于读取）
 * ctx.request.upstreamHeaders 要追加到上游的请求头
 * ctx.key / ctx.key.provider / ctx.endpoint / ctx.requestId / ctx.state
 * ctx.crypto / ctx.base64 / ctx.url（也可从 ctx.modules 访问）
 */
async function onRequest(ctx) {
  // 示例：固定温度，并给上游增加一个由请求内容计算的标记。
  // ctx.request.body.temperature = 0.2;
  // ctx.request.upstreamHeaders['x-body-sha256'] = ctx.crypto.sha256(
  //   JSON.stringify(ctx.request.body),
  // );

  return ctx.request;
}

/**
 * 上游响应返回客户端前执行。
 *
 * 普通响应：ctx.response.phase === 'complete'，body 是 JSON。
 * 流式响应：先收到 'headers'，随后每个 'chunk' 的 body 是 SSE 文本。
 */
async function onResponse(ctx) {
  // 示例：给普通 JSON 响应附加一个字段。
  // if (ctx.response.phase === 'complete' && ctx.response.body) {
  //   ctx.response.body.processed_by = 'xRouter middleware';
  // }

  return ctx.response;
}
`;

export type KeyMiddlewareLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface KeyMiddlewareRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
  upstreamHeaders: Record<string, string>;
}

export interface KeyMiddlewareResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  stream: boolean;
  phase: 'headers' | 'chunk' | 'complete';
}

export interface KeyMiddlewareProvider {
  id: string;
  name: string;
  slug: string;
  authType: 'oauth' | 'api_key';
  apiMode: GatewayEndpoint;
  baseUrl: string;
  defaultModel: string | null;
}

export interface KeyMiddlewareMetadata {
  key: {
    id: string;
    name: string;
    prefix: string;
    budgetUsd: number | null;
    spendUsd: number;
    rpmLimit: number;
    provider: KeyMiddlewareProvider;
  };
  endpoint: GatewayEndpoint;
  requestId: string;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface WorkerReply {
  id?: number;
  type: 'result' | 'error' | 'log';
  result?: unknown;
  error?: { name?: string; message?: string };
  level?: KeyMiddlewareLogLevel;
  values?: string[];
}

const WORKER_SOURCE = String.raw`
const { parentPort } = require('node:worker_threads');
const vm = require('node:vm');
const { createHash, createHmac, randomUUID } = require('node:crypto');

let context;
let hooks;
let metadata;
let currentRequest;
const state = Object.create(null);

function text(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function postLog(level, values) {
  parentPort.postMessage({ type: 'log', level, values: values.map(text) });
}

const log = Object.freeze({
  debug: (...values) => postLog('debug', values),
  info: (...values) => postLog('info', values),
  warn: (...values) => postLog('warn', values),
  error: (...values) => postLog('error', values),
});

const crypto = Object.freeze({
  randomUUID,
  sha256: (value) => createHash('sha256').update(String(value)).digest('hex'),
  hmacSha256: (secret, value) =>
    createHmac('sha256', String(secret)).update(String(value)).digest('hex'),
});

const base64 = Object.freeze({
  encode: (value) => Buffer.from(String(value), 'utf8').toString('base64'),
  decode: (value) => Buffer.from(String(value), 'base64').toString('utf8'),
  urlEncode: (value) => Buffer.from(String(value), 'utf8').toString('base64url'),
  urlDecode: (value) => Buffer.from(String(value), 'base64url').toString('utf8'),
});

const url = Object.freeze({
  parse: (value) => {
    const parsed = new URL(String(value));
    return {
      href: parsed.href,
      origin: parsed.origin,
      protocol: parsed.protocol,
      host: parsed.host,
      hostname: parsed.hostname,
      port: parsed.port,
      pathname: parsed.pathname,
      search: parsed.search,
      hash: parsed.hash,
      query: Object.fromEntries(parsed.searchParams.entries()),
    };
  },
  resolve: (value, base) => new URL(String(value), String(base)).href,
});

const modules = Object.freeze({ crypto, base64, url });

function middlewareContext(payload) {
  if (payload.request) currentRequest = payload.request;
  return {
    request: currentRequest,
    ...(payload.response ? { response: payload.response } : {}),
    key: metadata.key,
    endpoint: metadata.endpoint,
    requestId: metadata.requestId,
    state,
    crypto,
    base64,
    url,
    modules,
    log,
  };
}

function asyncHook(name) {
  const hook = hooks[name];
  if (typeof hook !== 'function') throw new Error('必须定义 async function ' + name + '(ctx)。');
  if (Object.prototype.toString.call(hook) !== '[object AsyncFunction]') {
    throw new Error(name + ' 必须使用 async function 定义。');
  }
}

function initialize(code, nextMetadata) {
  metadata = nextMetadata;
  context = vm.createContext(Object.create(null), {
    name: 'xrouter-key-middleware',
    codeGeneration: { strings: false, wasm: false },
  });
  const wrapped =
    '\"use strict\"; globalThis.__hooks = (() => {\n' +
    code +
    '\nreturn { onRequest, onResponse };\n})();';
  const script = new vm.Script(wrapped, { filename: 'api-key-middleware.js' });
  script.runInContext(context);
  hooks = context.__hooks;
  asyncHook('onRequest');
  asyncHook('onResponse');
}

async function runHook(name, payload) {
  context.__ctx = middlewareContext(payload);
  const call = new vm.Script(
    'globalThis.__result = globalThis.__hooks.' + name + '(globalThis.__ctx);',
    { filename: 'api-key-middleware-' + name + '.js' },
  );
  call.runInContext(context);
  const returned = await context.__result;
  const target = returned === undefined
    ? context.__ctx[name === 'onRequest' ? 'request' : 'response']
    : returned;
  if (name === 'onRequest') currentRequest = target;
  context.__ctx = undefined;
  context.__result = undefined;
  return target;
}

parentPort.on('message', async (message) => {
  try {
    if (message.type === 'init') initialize(message.code, message.metadata);
    const result = message.type === 'run'
      ? await runHook(message.hook, message.payload)
      : { ok: true };
    parentPort.postMessage({ id: message.id, type: 'result', result });
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      type: 'error',
      error: { name: error && error.name, message: error && error.message ? error.message : String(error) },
    });
  }
});
`;

export class KeyMiddlewareError extends Error {
  readonly statusCode = 500;
  readonly code = 'middleware_execution_failed';
  readonly exposeMessage = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'KeyMiddlewareError';
  }
}

function middlewareError(message: string, cause?: unknown): KeyMiddlewareError {
  return new KeyMiddlewareError(message, cause instanceof Error ? { cause } : undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRequest(value: unknown): KeyMiddlewareRequest {
  if (!isRecord(value) || !isRecord(value.body) || !isRecord(value.headers)) {
    throw middlewareError('API Key 中间件 onRequest 必须返回 ctx.request。');
  }
  const upstreamHeaders = value.upstreamHeaders;
  if (!isRecord(upstreamHeaders)) {
    throw middlewareError('ctx.request.upstreamHeaders 必须是对象。');
  }
  const normalizedUpstreamHeaders: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(upstreamHeaders)) {
    if (typeof headerValue !== 'string') {
      throw middlewareError(`上游请求头 ${name} 必须是字符串。`);
    }
    normalizedUpstreamHeaders[name] = headerValue;
  }
  return {
    method: typeof value.method === 'string' ? value.method : 'POST',
    url: typeof value.url === 'string' ? value.url : '',
    headers: value.headers as KeyMiddlewareRequest['headers'],
    body: value.body,
    upstreamHeaders: normalizedUpstreamHeaders,
  };
}

function normalizeResponse(value: unknown): KeyMiddlewareResponse {
  if (!isRecord(value) || !Number.isInteger(value.status) || !isRecord(value.headers)) {
    throw middlewareError('API Key 中间件 onResponse 必须返回 ctx.response。');
  }
  const status = Number(value.status);
  if (status < 100 || status > 599) {
    throw middlewareError('ctx.response.status 必须是 100 到 599 之间的整数。');
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value.headers)) {
    if (typeof headerValue !== 'string') {
      throw middlewareError(`响应头 ${name} 必须是字符串。`);
    }
    headers[name] = headerValue;
  }
  if (!['headers', 'chunk', 'complete'].includes(String(value.phase))) {
    throw middlewareError('ctx.response.phase 无效。');
  }
  return {
    status,
    headers,
    body: value.body,
    stream: value.stream === true,
    phase: value.phase as KeyMiddlewareResponse['phase'],
  };
}

export class KeyMiddlewareSession {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 1;
  private disposed = false;
  private failure: Error | undefined;
  private readonly initialized: Promise<unknown>;

  constructor(
    code: string,
    metadata: KeyMiddlewareMetadata,
    private readonly logger?: (level: KeyMiddlewareLogLevel, values: string[]) => void,
  ) {
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      resourceLimits: { maxOldGenerationSizeMb: 24, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
    });
    this.worker.on('message', (message: WorkerReply) => this.handleMessage(message));
    this.worker.on('error', (error) => this.fail(error));
    this.worker.on('exit', (codeValue) => {
      if (!this.disposed && codeValue !== 0) {
        this.fail(middlewareError(`API Key 中间件 Worker 异常退出（${codeValue}）。`));
      }
    });
    this.initialized = this.call({ type: 'init', code, metadata });
  }

  async ready(): Promise<void> {
    await this.initialized;
  }

  async onRequest(request: KeyMiddlewareRequest): Promise<KeyMiddlewareRequest> {
    await this.ready();
    try {
      return normalizeRequest(
        await this.call({ type: 'run', hook: 'onRequest', payload: { request } }),
      );
    } catch (error) {
      throw middlewareError(
        `API Key 中间件 onRequest 执行失败：${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  }

  async onResponse(response: KeyMiddlewareResponse): Promise<KeyMiddlewareResponse> {
    await this.ready();
    try {
      return normalizeResponse(
        await this.call({ type: 'run', hook: 'onResponse', payload: { response } }),
      );
    } catch (error) {
      throw middlewareError(
        `API Key 中间件 onResponse 执行失败：${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const call of this.pending.values()) {
      call.reject(middlewareError('API Key 中间件 Worker 已关闭。'));
    }
    this.pending.clear();
    await this.worker.terminate();
  }

  private call(payload: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) return Promise.reject(middlewareError('API Key 中间件 Worker 已关闭。'));
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...payload });
    });
  }

  private handleMessage(message: WorkerReply): void {
    if (message.type === 'log') {
      this.logger?.(message.level ?? 'info', message.values ?? []);
      return;
    }
    if (message.id === undefined) return;
    const call = this.pending.get(message.id);
    if (!call) return;
    this.pending.delete(message.id);
    if (message.type === 'error') {
      call.reject(
        middlewareError(
          message.error?.message ?? message.error?.name ?? 'API Key 中间件执行失败。',
        ),
      );
      return;
    }
    call.resolve(message.result);
  }

  private fail(reason: unknown): void {
    const error =
      reason instanceof KeyMiddlewareError
        ? reason
        : middlewareError(reason instanceof Error ? reason.message : String(reason), reason);
    this.failure = error;
    for (const call of this.pending.values()) {
      call.reject(error);
    }
    this.pending.clear();
  }
}

export async function createKeyMiddlewareSession(input: {
  code: string;
  metadata: KeyMiddlewareMetadata;
  logger?: (level: KeyMiddlewareLogLevel, values: string[]) => void;
}): Promise<KeyMiddlewareSession> {
  const session = new KeyMiddlewareSession(input.code, input.metadata, input.logger);
  try {
    await session.ready();
    return session;
  } catch (error) {
    await session.dispose();
    throw middlewareError(
      `API Key 中间件初始化失败：${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

export async function validateKeyMiddlewareCode(code: string): Promise<void> {
  const session = new KeyMiddlewareSession(code, {
    key: {
      id: 'validation',
      name: 'validation',
      prefix: 'xr_validation',
      budgetUsd: null,
      spendUsd: 0,
      rpmLimit: 0,
      provider: {
        id: 'validation',
        name: 'validation',
        slug: 'openai',
        authType: 'api_key',
        apiMode: 'responses',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: null,
      },
    },
    endpoint: 'responses',
    requestId: 'validation',
  });
  try {
    await session.ready();
  } finally {
    await session.dispose();
  }
}
