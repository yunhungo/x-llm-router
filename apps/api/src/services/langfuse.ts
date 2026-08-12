import { LangfuseSpanProcessor } from '@langfuse/otel';
import { diag, DiagLogLevel, type DiagLogger } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';

import { getPool } from '../db/client';
import { decryptJson, encryptJson } from '../lib/crypto';

export interface KeyLangfuseSettings {
  enabled: boolean;
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  environment: string;
  traceName: string;
  version: string;
  tags: string[];
  metadata: Record<string, string>;
  userIdHeader: string;
  sessionIdHeader: string;
  captureInput: boolean;
  captureOutput: boolean;
}

interface LangfuseKeyRow {
  id: string;
  langfuse_config_ciphertext: string | null;
}

interface LangfuseKeyStatusRow extends LangfuseKeyRow {
  status: string;
}

const API_KEY_ATTRIBUTE = 'langfuse.trace.metadata.apiKeyId';
const LANGFUSE_AUTH_PATH = '/api/public/projects';
const LANGFUSE_OTLP_TRACES_PATH = '/api/public/otel/v1/traces';
const LANGFUSE_CONNECTION_TIMEOUT_MS = 10_000;
const SAFE_TELEMETRY_ERROR_CODES = new Set([
  'ABORT_ERR',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export type EditableLangfuseSettings = Omit<KeyLangfuseSettings, 'secretKey'> & {
  secretKey?: string;
};

export interface LangfuseConnectionTestResult {
  ok: true;
  baseUrl: string;
  statusCode: number;
}

type RuntimeSpanProcessor = Pick<
  LangfuseSpanProcessor,
  'forceFlush' | 'onEnd' | 'onStart' | 'shutdown'
>;

interface ProcessorState {
  apiKeyId: string;
  processor: RuntimeSpanProcessor;
  activeSpans: number;
  retired: boolean;
  disposePromise?: Promise<void>;
}

export function isLangfuseDiagnosticsEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    environment.LANGFUSE_DIAGNOSTICS?.trim().toLowerCase() ?? '',
  );
}

function writeLangfuseDiagnostic(
  level: 'info' | 'warn' | 'error',
  event: string,
  details: Record<string, unknown> = {},
  always = false,
): void {
  if (!always && !isLangfuseDiagnosticsEnabled()) return;
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    component: 'langfuse',
    event,
    ...details,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}

export function safeLangfuseBaseUrlForDiagnostics(baseUrl: string): string {
  try {
    const parsed = new URL(normalizeLangfuseBaseUrl(baseUrl));
    return parsed.origin;
  } catch {
    return '<invalid>';
  }
}

function projectDiagnosticFields(
  apiKeyId: string,
  settings: KeyLangfuseSettings,
): Record<string, unknown> {
  return {
    apiKeyId,
    publicKeyPrefix: settings.publicKey.slice(0, 12),
    baseUrl: safeLangfuseBaseUrlForDiagnostics(settings.baseUrl),
    environment: settings.environment,
  };
}

/**
 * Keeps one OpenTelemetry provider registered for the process while allowing
 * the per-key exporters behind it to change at runtime.
 */
export class ReloadableLangfuseSpanProcessor {
  private current = new Map<string, ProcessorState>();
  private readonly states = new Set<ProcessorState>();
  private readonly spanOwners = new WeakMap<object, readonly ProcessorState[]>();
  private closed = false;

  onStart(...args: Parameters<RuntimeSpanProcessor['onStart']>): void {
    if (this.closed) return;
    const states = [...new Set(this.current.values())];
    if (!states.length) return;

    for (const state of states) state.activeSpans += 1;
    this.spanOwners.set(args[0], states);

    for (const state of states) {
      try {
        state.processor.onStart(...args);
      } catch (error) {
        logSafeTelemetryWarning('Langfuse span processor failed while starting a span.', error);
      }
    }
  }

  onEnd(...args: Parameters<RuntimeSpanProcessor['onEnd']>): void {
    const span = args[0];
    const states = this.spanOwners.get(span);
    if (!states) return;
    this.spanOwners.delete(span);

    for (const state of states) {
      try {
        state.processor.onEnd(...args);
      } catch (error) {
        logSafeTelemetryWarning('Langfuse span processor failed while ending a span.', error);
      }
    }

    for (const state of states) {
      state.activeSpans = Math.max(0, state.activeSpans - 1);
      this.disposeWhenIdle(state);
    }

    if (isLangfuseDiagnosticsEnabled()) {
      const attributes = span.attributes as Record<string, unknown>;
      const rawApiKeyId = attributes?.[API_KEY_ATTRIBUTE];
      const apiKeyId = typeof rawApiKeyId === 'string' ? rawApiKeyId : undefined;
      const matchedProcessorCount = apiKeyId
        ? states.filter((state) => state.apiKeyId === apiKeyId).length
        : 0;
      const spanContext = span.spanContext();
      writeLangfuseDiagnostic('info', 'span_queued', {
        apiKeyId: apiKeyId ?? null,
        spanName: span.name,
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
        ownerProcessorCount: states.length,
        matchedProcessorCount,
        routed: matchedProcessorCount === 1,
      });
    }
  }

  async forceFlush(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.states].map((state) => state.disposePromise ?? state.processor.forceFlush()),
    );
    const failureCount = results.filter((result) => result.status === 'rejected').length;
    if (failureCount) {
      throw new Error(`Failed to flush ${failureCount} Langfuse processor(s).`);
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed && !this.states.size) return;
    this.closed = true;
    this.current = new Map();

    const disposals: Promise<void>[] = [];
    for (const state of this.states) {
      state.retired = true;
      disposals.push(this.dispose(state));
    }
    await Promise.all(disposals);
  }

  hasKey(apiKeyId: string): boolean {
    return this.current.has(apiKeyId);
  }

  replaceKey(apiKeyId: string, processor?: RuntimeSpanProcessor): void {
    if (this.closed) throw new Error('Langfuse telemetry has already been shut down.');

    const previous = this.current.get(apiKeyId);
    const next = new Map(this.current);
    if (processor) {
      const state: ProcessorState = { apiKeyId, processor, activeSpans: 0, retired: false };
      this.states.add(state);
      next.set(apiKeyId, state);
    } else {
      next.delete(apiKeyId);
    }
    this.current = next;

    if (previous && previous.processor !== processor) {
      previous.retired = true;
      this.disposeWhenIdle(previous);
    }
  }

  replaceAll(processors: ReadonlyMap<string, RuntimeSpanProcessor>): void {
    if (this.closed) throw new Error('Langfuse telemetry has already been shut down.');

    const previous = [...this.current.values()];
    const next = new Map<string, ProcessorState>();
    for (const [apiKeyId, processor] of processors) {
      const state: ProcessorState = { apiKeyId, processor, activeSpans: 0, retired: false };
      this.states.add(state);
      next.set(apiKeyId, state);
    }
    this.current = next;

    for (const state of previous) {
      state.retired = true;
      this.disposeWhenIdle(state);
    }
  }

  private disposeWhenIdle(state: ProcessorState): void {
    if (state.retired && state.activeSpans === 0) void this.dispose(state);
  }

  private dispose(state: ProcessorState): Promise<void> {
    state.disposePromise ??= (async () => {
      try {
        await state.processor.forceFlush();
      } catch (error) {
        logSafeTelemetryWarning('Failed to flush a retired Langfuse span processor.', error);
      }
      try {
        await state.processor.shutdown();
      } catch (error) {
        logSafeTelemetryWarning('Failed to shut down a retired Langfuse span processor.', error);
      }
    })().finally(() => this.states.delete(state));
    return state.disposePromise;
  }
}

const reloadableSpanProcessor = new ReloadableLangfuseSpanProcessor();
let telemetrySdk: NodeSDK | undefined;
let telemetryDiagnosticsConfigured = false;

type TelemetryDiagnosticCategory =
  'authentication' | 'connection' | 'dns' | 'export_failed' | 'rate_limit' | 'timeout' | 'upstream';

function telemetryDiagnosticText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value instanceof Error) {
    const error = value as Error & { code?: unknown; statusCode?: unknown };
    return `${error.name} ${error.message} ${String(error.code ?? '')} ${String(error.statusCode ?? '')}`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `${String(record.name ?? '')} ${String(record.message ?? '')} ${String(record.code ?? '')} ${String(record.statusCode ?? '')}`;
  }
  return '';
}

function telemetryDiagnosticCategory(value: unknown): TelemetryDiagnosticCategory {
  const text = telemetryDiagnosticText(value).slice(0, 2_000).toLowerCase();
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|auth(?:entication|orization)/.test(text)) {
    return 'authentication';
  }
  if (/\b429\b|rate.?limit|too many requests/.test(text)) return 'rate_limit';
  if (/timeout|timed out|etimedout|abort/.test(text)) return 'timeout';
  if (/enotfound|eai_again|\bdns\b/.test(text)) return 'dns';
  if (/econn|enetunreach|socket|connect/.test(text)) return 'connection';
  if (/\b5\d\d\b|upstream|service unavailable/.test(text)) return 'upstream';
  return 'export_failed';
}

function safeTelemetryErrorName(value: unknown): string {
  const name = typeof value === 'string' ? value.toLowerCase() : '';
  if (name.includes('otlp')) return 'OTLPExporterError';
  if (name.includes('abort')) return 'AbortError';
  if (name.includes('aggregate')) return 'AggregateError';
  if (name.includes('type')) return 'TypeError';
  return 'Error';
}

function safeTelemetryErrorCode(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  if (/^\d{3}$/.test(value)) return Number(value);
  const normalized = value.toUpperCase();
  return SAFE_TELEMETRY_ERROR_CODES.has(normalized) ? normalized : undefined;
}

/**
 * Retains only transport-level diagnostics. Response bodies, headers, span
 * attributes and arbitrary objects are deliberately discarded.
 */
export function safeTelemetryDiagnosticValue(value: unknown): unknown {
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;

  if (value instanceof Error) {
    const error = value as Error & { code?: unknown; statusCode?: unknown };
    const code = safeTelemetryErrorCode(error.code);
    const statusCode = safeTelemetryErrorCode(error.statusCode);
    return {
      type: 'Error',
      name: safeTelemetryErrorName(error.name),
      category: telemetryDiagnosticCategory(error),
      ...(code === undefined ? {} : { code }),
      ...(statusCode === undefined ? {} : { statusCode }),
    };
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const code = safeTelemetryErrorCode(record.code);
    const statusCode = safeTelemetryErrorCode(record.statusCode);
    return {
      type: 'Object',
      name: safeTelemetryErrorName(record.name),
      category: telemetryDiagnosticCategory(record),
      ...(code === undefined ? {} : { code }),
      ...(statusCode === undefined ? {} : { statusCode }),
    };
  }

  return { type: typeof value, category: telemetryDiagnosticCategory(value) };
}

function logSafeTelemetryWarning(message: string, error: unknown): void {
  writeLangfuseDiagnostic(
    'warn',
    'runtime_warning',
    { message, details: safeTelemetryDiagnosticValue(error) },
    true,
  );
}

const noopDiagnostic = (_message: string, ..._args: unknown[]): void => undefined;
const safeTelemetryDiagnosticLogger: DiagLogger = {
  error: (message, ...args) => {
    const categories = [message, ...args].map(telemetryDiagnosticCategory);
    writeLangfuseDiagnostic(
      'error',
      'otel_export_error',
      {
        category: categories.find((category) => category !== 'export_failed') ?? 'export_failed',
        details: args.map(safeTelemetryDiagnosticValue),
      },
      true,
    );
  },
  warn: noopDiagnostic,
  info: noopDiagnostic,
  debug: noopDiagnostic,
  verbose: noopDiagnostic,
};

function configureTelemetryDiagnostics(): void {
  if (telemetryDiagnosticsConfigured) return;
  diag.setLogger(safeTelemetryDiagnosticLogger, {
    logLevel: DiagLogLevel.ERROR,
    suppressOverrideMessage: true,
  });
  telemetryDiagnosticsConfigured = true;
  writeLangfuseDiagnostic('info', 'otel_diagnostics_configured');
}

export function normalizeLangfuseBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function createLangfuseSpanProcessor(
  apiKeyId: string,
  settings: KeyLangfuseSettings,
): LangfuseSpanProcessor {
  return new LangfuseSpanProcessor({
    publicKey: settings.publicKey,
    secretKey: settings.secretKey,
    baseUrl: normalizeLangfuseBaseUrl(settings.baseUrl),
    environment: settings.environment,
    shouldExportSpan: ({ otelSpan }) => otelSpan.attributes[API_KEY_ATTRIBUTE] === apiKeyId,
  });
}

function ensureTelemetryStarted(): void {
  if (telemetrySdk) return;
  configureTelemetryDiagnostics();
  const sdk = new NodeSDK({ spanProcessors: [reloadableSpanProcessor] });
  sdk.start();
  telemetrySdk = sdk;
  writeLangfuseDiagnostic('info', 'telemetry_sdk_started', {
    nodeUseEnvProxy: process.env.NODE_USE_ENV_PROXY ?? null,
    httpProxyConfigured: Boolean(process.env.HTTP_PROXY || process.env.http_proxy),
    httpsProxyConfigured: Boolean(process.env.HTTPS_PROXY || process.env.https_proxy),
    noProxyConfigured: Boolean(process.env.NO_PROXY || process.env.no_proxy),
  });
}

async function disposeUnusedProcessor(processor: RuntimeSpanProcessor): Promise<void> {
  try {
    await processor.forceFlush();
  } catch (error) {
    logSafeTelemetryWarning('Failed to flush an unused Langfuse span processor.', error);
  }
  try {
    await processor.shutdown();
  } catch (error) {
    logSafeTelemetryWarning('Failed to shut down an unused Langfuse span processor.', error);
  }
}

export function defaultLangfuseSettings(): KeyLangfuseSettings {
  return {
    enabled: false,
    publicKey: '',
    secretKey: '',
    baseUrl: 'https://cloud.langfuse.com',
    environment: 'production',
    traceName: '',
    version: '',
    tags: [],
    metadata: {},
    userIdHeader: 'x-user-id',
    sessionIdHeader: 'x-session-id',
    captureInput: true,
    captureOutput: true,
  };
}

export function encryptLangfuseSettings(settings: KeyLangfuseSettings): string {
  return encryptJson({ ...settings, baseUrl: normalizeLangfuseBaseUrl(settings.baseUrl) });
}

export function decryptLangfuseSettings(
  ciphertext: string | null | undefined,
): KeyLangfuseSettings | undefined {
  if (!ciphertext) return undefined;
  const settings = {
    ...defaultLangfuseSettings(),
    ...decryptJson<Partial<KeyLangfuseSettings>>(ciphertext),
  };
  return { ...settings, baseUrl: normalizeLangfuseBaseUrl(settings.baseUrl) };
}

export function publicLangfuseSettings(settings?: KeyLangfuseSettings): Record<string, unknown> {
  const value = settings ?? defaultLangfuseSettings();
  return {
    enabled: value.enabled,
    publicKey: value.publicKey,
    hasSecretKey: Boolean(value.secretKey),
    baseUrl: normalizeLangfuseBaseUrl(value.baseUrl),
    environment: value.environment,
    traceName: value.traceName,
    version: value.version,
    tags: value.tags,
    metadata: value.metadata,
    userIdHeader: value.userIdHeader,
    sessionIdHeader: value.sessionIdHeader,
    captureInput: value.captureInput,
    captureOutput: value.captureOutput,
    restartRequiredAfterSave: false,
  };
}

function langfuseConnectionError(
  message: string,
  statusCode: number,
  code: string,
): Error & { statusCode: number; code: string; exposeMessage: true } {
  return Object.assign(new Error(message), { statusCode, code, exposeMessage: true as const });
}

async function fetchLangfuseConnectionEndpoint(
  endpoint: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), LANGFUSE_CONNECTION_TIMEOUT_MS);
  try {
    return await fetchImpl(endpoint, {
      ...init,
      redirect: 'error',
      signal: abortController.signal,
    });
  } catch {
    if (abortController.signal.aborted) {
      throw langfuseConnectionError(
        'Langfuse 连接超时，请检查 Base URL、代理和 NO_PROXY。',
        504,
        'langfuse_connection_timeout',
      );
    }
    throw langfuseConnectionError(
      '无法连接 Langfuse，请检查 Base URL、重定向、DNS、代理和 NO_PROXY。',
      502,
      'langfuse_connection_failed',
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkLangfuseConnection(
  settings: KeyLangfuseSettings,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<LangfuseConnectionTestResult> {
  if (!settings.publicKey || !settings.secretKey) {
    throw langfuseConnectionError(
      '测试 Langfuse 连接需要 Public Key 和 Secret Key。',
      400,
      'langfuse_credentials_required',
    );
  }

  const baseUrl = normalizeLangfuseBaseUrl(settings.baseUrl);
  let endpointBase: string;
  try {
    const parsedBaseUrl = new URL(baseUrl);
    if (
      !['http:', 'https:'].includes(parsedBaseUrl.protocol) ||
      parsedBaseUrl.username ||
      parsedBaseUrl.password ||
      parsedBaseUrl.search ||
      parsedBaseUrl.hash
    ) {
      throw new TypeError('Unsupported Langfuse Base URL');
    }
    parsedBaseUrl.hash = '';
    parsedBaseUrl.search = '';
    endpointBase = parsedBaseUrl.toString().replace(/\/+$/, '');
  } catch {
    throw langfuseConnectionError('Langfuse Base URL 无效。', 400, 'langfuse_base_url_invalid');
  }

  const authorization = `Basic ${Buffer.from(`${settings.publicKey}:${settings.secretKey}`).toString('base64')}`;
  const response = await fetchLangfuseConnectionEndpoint(
    `${endpointBase}${LANGFUSE_AUTH_PATH}`,
    {
      method: 'GET',
      headers: { accept: 'application/json', authorization },
    },
    fetchImpl,
  );

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 401 || response.status === 403) {
    throw langfuseConnectionError(
      'Langfuse 鉴权失败，请确认 API Key 与 Base URL 所在区域及项目一致。',
      400,
      'langfuse_auth_failed',
    );
  }
  if (response.status === 404) {
    throw langfuseConnectionError(
      'Langfuse API 路径不存在；Base URL 应只填写实例地址，不要包含 /api/public。',
      400,
      'langfuse_endpoint_not_found',
    );
  }
  if (!response.ok) {
    throw langfuseConnectionError(
      `Langfuse 返回 HTTP ${response.status}，请检查实例状态或反向代理。`,
      502,
      'langfuse_upstream_error',
    );
  }
  if (!contentType.includes('application/json')) {
    throw langfuseConnectionError(
      'Langfuse 返回了非 JSON 响应，请确认 Base URL 没有指向登录页或其他服务。',
      502,
      'langfuse_invalid_response',
    );
  }

  const otlpResponse = await fetchLangfuseConnectionEndpoint(
    `${endpointBase}${LANGFUSE_OTLP_TRACES_PATH}`,
    {
      method: 'POST',
      headers: {
        accept: 'application/x-protobuf',
        authorization,
        'content-type': 'application/x-protobuf',
      },
      body: new Uint8Array(),
    },
    fetchImpl,
  );
  await otlpResponse.body?.cancel().catch(() => undefined);
  if (otlpResponse.status === 401 || otlpResponse.status === 403) {
    throw langfuseConnectionError(
      'Langfuse OTLP 鉴权失败，请确认 API Key 与 Base URL 所在区域及项目一致。',
      400,
      'langfuse_otlp_auth_failed',
    );
  }
  if (otlpResponse.status === 404) {
    throw langfuseConnectionError(
      'Langfuse OTLP traces 路径不存在，请检查实例版本和反向代理配置。',
      400,
      'langfuse_otlp_endpoint_not_found',
    );
  }
  if (!otlpResponse.ok) {
    throw langfuseConnectionError(
      `Langfuse OTLP 返回 HTTP ${otlpResponse.status}，请检查实例状态或反向代理。`,
      502,
      'langfuse_otlp_upstream_error',
    );
  }

  return { ok: true, baseUrl, statusCode: otlpResponse.status };
}

export async function testApiKeyLangfuseConnection(
  apiKeyId: string,
  input: EditableLangfuseSettings,
): Promise<LangfuseConnectionTestResult | undefined> {
  const result = await getPool().query<LangfuseKeyRow>(
    'SELECT id, langfuse_config_ciphertext FROM virtual_api_keys WHERE id = $1',
    [apiKeyId],
  );
  const row = result.rows[0];
  if (!row) return undefined;

  const existing = decryptLangfuseSettings(row.langfuse_config_ciphertext);
  const settings: KeyLangfuseSettings = {
    ...input,
    baseUrl: normalizeLangfuseBaseUrl(input.baseUrl),
    secretKey: input.secretKey || existing?.secretKey || '',
  };
  return checkLangfuseConnection(settings);
}

export async function saveApiKeyLangfuseSettings(
  apiKeyId: string,
  input: EditableLangfuseSettings,
): Promise<boolean> {
  const existingResult = await getPool().query<LangfuseKeyStatusRow>(
    'SELECT id, status, langfuse_config_ciphertext FROM virtual_api_keys WHERE id = $1',
    [apiKeyId],
  );
  const row = existingResult.rows[0];
  if (!row) return false;

  const existing = decryptLangfuseSettings(row.langfuse_config_ciphertext);
  const settings: KeyLangfuseSettings = {
    ...input,
    baseUrl: normalizeLangfuseBaseUrl(input.baseUrl),
    secretKey: input.secretKey || existing?.secretKey || '',
  };
  if (settings.enabled && (!settings.publicKey || !settings.secretKey)) {
    throw Object.assign(new Error('启用 Langfuse 需要 Public Key 和 Secret Key。'), {
      statusCode: 400,
      code: 'langfuse_credentials_required',
    });
  }

  let nextProcessor: LangfuseSpanProcessor | undefined;
  try {
    if (row.status === 'active' && settings.enabled) {
      nextProcessor = createLangfuseSpanProcessor(apiKeyId, settings);
    }
    ensureTelemetryStarted();
    await getPool().query(
      'UPDATE virtual_api_keys SET langfuse_config_ciphertext = $2 WHERE id = $1',
      [apiKeyId, encryptLangfuseSettings(settings)],
    );
  } catch (error) {
    if (nextProcessor) await disposeUnusedProcessor(nextProcessor);
    throw error;
  }

  reloadableSpanProcessor.replaceKey(apiKeyId, nextProcessor);
  writeLangfuseDiagnostic('info', 'project_configuration_applied', {
    ...projectDiagnosticFields(apiKeyId, settings),
    source: 'settings_save',
    registered: Boolean(nextProcessor),
  });
  return true;
}

/**
 * Self-heals runtime registration for keys created after process startup.
 * This runs before the gateway starts its observation, so the first request
 * for a newly created key is eligible for export without a service restart.
 */
export async function ensureApiKeyLangfuse(
  apiKeyId: string,
  settings: KeyLangfuseSettings,
): Promise<boolean> {
  if (!settings.enabled || !settings.publicKey || !settings.secretKey) {
    writeLangfuseDiagnostic('warn', 'project_registration_skipped', {
      apiKeyId,
      source: 'gateway_request',
      enabled: settings.enabled,
      hasPublicKey: Boolean(settings.publicKey),
      hasSecretKey: Boolean(settings.secretKey),
    });
    return false;
  }
  if (reloadableSpanProcessor.hasKey(apiKeyId)) {
    writeLangfuseDiagnostic('info', 'project_registration_checked', {
      ...projectDiagnosticFields(apiKeyId, settings),
      source: 'gateway_request',
      status: 'ready',
    });
    return true;
  }

  let processor: LangfuseSpanProcessor | undefined;
  try {
    processor = createLangfuseSpanProcessor(apiKeyId, settings);
    ensureTelemetryStarted();
    reloadableSpanProcessor.replaceKey(apiKeyId, processor);
    writeLangfuseDiagnostic('info', 'project_registration_checked', {
      ...projectDiagnosticFields(apiKeyId, settings),
      source: 'gateway_request',
      status: 'registered',
    });
    return true;
  } catch (error) {
    if (processor) await disposeUnusedProcessor(processor);
    throw error;
  }
}

export async function initializeLangfuse(): Promise<number> {
  const result = await getPool().query<LangfuseKeyRow>(
    `SELECT id, langfuse_config_ciphertext
       FROM virtual_api_keys
      WHERE status = 'active' AND langfuse_config_ciphertext IS NOT NULL`,
  );
  const configured = new Map<string, LangfuseSpanProcessor>();

  for (const row of result.rows) {
    try {
      const settings = decryptLangfuseSettings(row.langfuse_config_ciphertext);
      if (settings?.enabled && settings.publicKey && settings.secretKey) {
        configured.set(row.id, createLangfuseSpanProcessor(row.id, settings));
        writeLangfuseDiagnostic('info', 'project_loaded', {
          ...projectDiagnosticFields(row.id, settings),
          source: 'startup',
        });
      }
    } catch (error) {
      writeLangfuseDiagnostic(
        'warn',
        'project_load_failed',
        { apiKeyId: row.id, details: safeTelemetryDiagnosticValue(error) },
        true,
      );
    }
  }

  try {
    ensureTelemetryStarted();
    reloadableSpanProcessor.replaceAll(configured);
  } catch (error) {
    await Promise.all([...configured.values()].map(disposeUnusedProcessor));
    throw error;
  }
  writeLangfuseDiagnostic('info', 'runtime_initialized', {
    registeredProjectCount: configured.size,
    configuredRowCount: result.rows.length,
  });
  return configured.size;
}

export async function shutdownLangfuse(): Promise<void> {
  const sdk = telemetrySdk;
  telemetrySdk = undefined;
  if (!sdk) return;
  writeLangfuseDiagnostic('info', 'runtime_shutdown_started');
  await sdk.shutdown();
  writeLangfuseDiagnostic('info', 'runtime_shutdown_completed');
}
