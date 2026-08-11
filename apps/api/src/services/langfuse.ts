import { LangfuseSpanProcessor } from '@langfuse/otel';
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

type RuntimeSpanProcessor = Pick<
  LangfuseSpanProcessor,
  'forceFlush' | 'onEnd' | 'onStart' | 'shutdown'
>;

interface ProcessorState {
  processor: RuntimeSpanProcessor;
  activeSpans: number;
  retired: boolean;
  disposePromise?: Promise<void>;
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
        console.warn('Langfuse span processor failed while starting a span.', error);
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
        console.warn('Langfuse span processor failed while ending a span.', error);
      }
    }

    for (const state of states) {
      state.activeSpans = Math.max(0, state.activeSpans - 1);
      this.disposeWhenIdle(state);
    }
  }

  async forceFlush(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.states].map((state) => state.disposePromise ?? state.processor.forceFlush()),
    );
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Failed to flush Langfuse processors.');
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

  replaceKey(apiKeyId: string, processor?: RuntimeSpanProcessor): void {
    if (this.closed) throw new Error('Langfuse telemetry has already been shut down.');

    const previous = this.current.get(apiKeyId);
    const next = new Map(this.current);
    if (processor) {
      const state: ProcessorState = { processor, activeSpans: 0, retired: false };
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
      const state: ProcessorState = { processor, activeSpans: 0, retired: false };
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
        console.warn('Failed to flush a retired Langfuse span processor.', error);
      }
      try {
        await state.processor.shutdown();
      } catch (error) {
        console.warn('Failed to shut down a retired Langfuse span processor.', error);
      }
    })().finally(() => this.states.delete(state));
    return state.disposePromise;
  }
}

const reloadableSpanProcessor = new ReloadableLangfuseSpanProcessor();
let telemetrySdk: NodeSDK | undefined;

function createLangfuseSpanProcessor(
  apiKeyId: string,
  settings: KeyLangfuseSettings,
): LangfuseSpanProcessor {
  return new LangfuseSpanProcessor({
    publicKey: settings.publicKey,
    secretKey: settings.secretKey,
    baseUrl: settings.baseUrl,
    environment: settings.environment,
    shouldExportSpan: ({ otelSpan }) => otelSpan.attributes[API_KEY_ATTRIBUTE] === apiKeyId,
  });
}

function ensureTelemetryStarted(): void {
  if (telemetrySdk) return;
  const sdk = new NodeSDK({ spanProcessors: [reloadableSpanProcessor] });
  sdk.start();
  telemetrySdk = sdk;
}

async function disposeUnusedProcessor(processor: RuntimeSpanProcessor): Promise<void> {
  try {
    await processor.forceFlush();
  } catch (error) {
    console.warn('Failed to flush an unused Langfuse span processor.', error);
  }
  try {
    await processor.shutdown();
  } catch (error) {
    console.warn('Failed to shut down an unused Langfuse span processor.', error);
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
  return encryptJson(settings);
}

export function decryptLangfuseSettings(
  ciphertext: string | null | undefined,
): KeyLangfuseSettings | undefined {
  if (!ciphertext) return undefined;
  return {
    ...defaultLangfuseSettings(),
    ...decryptJson<Partial<KeyLangfuseSettings>>(ciphertext),
  };
}

export function publicLangfuseSettings(settings?: KeyLangfuseSettings): Record<string, unknown> {
  const value = settings ?? defaultLangfuseSettings();
  return {
    enabled: value.enabled,
    publicKey: value.publicKey,
    hasSecretKey: Boolean(value.secretKey),
    baseUrl: value.baseUrl,
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

export async function saveApiKeyLangfuseSettings(
  apiKeyId: string,
  input: Omit<KeyLangfuseSettings, 'secretKey'> & { secretKey?: string },
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
  return true;
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
      }
    } catch {
      console.warn(`Skipping invalid Langfuse configuration for API key ${row.id}.`);
    }
  }

  try {
    ensureTelemetryStarted();
    reloadableSpanProcessor.replaceAll(configured);
  } catch (error) {
    await Promise.all([...configured.values()].map(disposeUnusedProcessor));
    throw error;
  }
  return configured.size;
}

export async function shutdownLangfuse(): Promise<void> {
  const sdk = telemetrySdk;
  telemetrySdk = undefined;
  if (sdk) await sdk.shutdown();
}
