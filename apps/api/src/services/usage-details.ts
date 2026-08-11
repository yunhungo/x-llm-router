import type { FastifyInstance } from 'fastify';

import { getPool } from '../db/client';

const REDACTED = '[REDACTED]';
const MAX_STORED_JSON_BYTES = 256 * 1024;
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const sensitiveKeys = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'apikey',
  'xapikey',
  'openaiapikey',
  'secret',
  'secretkey',
  'clientsecret',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'password',
  'passwd',
  'credentials',
  'credentialsciphertext',
]);
const sensitiveKeySuffixes = [
  'authorization',
  'apikey',
  'clientsecret',
  'secretkey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'password',
  'passwd',
  'credentials',
  'credentialsciphertext',
];

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(value: string): boolean {
  const key = normalizedKey(value);
  return sensitiveKeys.has(key) || sensitiveKeySuffixes.some((suffix) => key.endsWith(suffix));
}

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 16) return '[MAX_DEPTH]';
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      isSensitiveKey(key) ? REDACTED : redactSensitive(item, depth + 1),
    ]),
  );
}

export function prepareStoredJson(value: unknown, maxBytes = MAX_STORED_JSON_BYTES): unknown {
  const sanitized = redactSensitive(value);
  const serialized = JSON.stringify(sanitized);
  const byteLength = Buffer.byteLength(serialized);
  if (byteLength <= maxBytes) return sanitized;
  return {
    _truncated: true,
    originalBytes: byteLength,
    preview: serialized.slice(0, Math.max(0, maxBytes - 128)),
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildCurl(input: {
  url: string;
  body: unknown;
  authorization: '<ROUTER_API_KEY>' | '<UPSTREAM_CREDENTIAL>';
  accept?: string;
  requestId?: string;
}): string {
  const body = JSON.stringify(redactSensitive(input.body), null, 2);
  const lines = [
    `curl ${shellQuote(input.url)} \\`,
    `  -H ${shellQuote(`Authorization: Bearer ${input.authorization}`)} \\`,
    `  -H ${shellQuote('Content-Type: application/json')} \\`,
  ];
  if (input.accept) lines.push(`  -H ${shellQuote(`Accept: ${input.accept}`)} \\`);
  if (input.requestId) lines.push(`  -H ${shellQuote(`X-Request-Id: ${input.requestId}`)} \\`);
  lines.push(`  --data-raw ${shellQuote(body)}`);
  return lines.join('\n');
}

export class SseDetailCollector {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private readonly events: unknown[] = [];
  private completedResponse: unknown;
  private totalBytes = 0;
  private storedEventBytes = 0;
  private truncated = false;

  feed(chunk: Uint8Array, final = false): void {
    this.totalBytes += chunk.byteLength;
    this.buffer += this.decoder.decode(chunk, { stream: !final });
    const blocks = this.buffer.split(/\r?\n\r?\n/);
    const tail = blocks.pop() ?? '';
    this.buffer = final ? '' : tail;
    for (const block of blocks) this.consume(block);
    if (final && tail) this.consume(tail);
  }

  snapshot(): unknown {
    if (this.completedResponse !== undefined) return this.completedResponse;
    return {
      stream: true,
      events: this.events,
      bytes: this.totalBytes,
      truncated: this.truncated,
    };
  }

  private consume(block: string): void {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    try {
      const event = JSON.parse(data) as Record<string, unknown>;
      if (event.type === 'response.completed' && event.response !== undefined) {
        this.completedResponse = event.response;
      }
      const eventBytes = Buffer.byteLength(data);
      if (this.storedEventBytes + eventBytes <= MAX_STORED_JSON_BYTES) {
        this.events.push(event);
        this.storedEventBytes += eventBytes;
      } else {
        this.truncated = true;
      }
    } catch {
      // Non-JSON keepalive frames are not useful in a stored call detail.
    }
  }
}

export async function purgeExpiredUsageDetails(): Promise<number> {
  const result = await getPool().query('DELETE FROM usage_log_details WHERE expires_at <= now()');
  return result.rowCount ?? 0;
}

export function registerUsageDetailRetention(app: FastifyInstance): void {
  void purgeExpiredUsageDetails().catch((error: unknown) => {
    app.log.error({ err: error }, 'Failed to purge expired usage details');
  });
  const timer = setInterval(() => {
    void purgeExpiredUsageDetails().catch((error: unknown) => {
      app.log.error({ err: error }, 'Failed to purge expired usage details');
    });
  }, RETENTION_INTERVAL_MS);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}
