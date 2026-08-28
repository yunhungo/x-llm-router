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

function isSensitiveHeaderName(value: string): boolean {
  const key = normalizedKey(value);
  return (
    key === 'authorization' ||
    key === 'proxyauthorization' ||
    key === 'cookie' ||
    key === 'setcookie' ||
    key === 'auth' ||
    key.endsWith('auth') ||
    ['apikey', 'token', 'secret', 'credential', 'signature'].some((marker) => key.includes(marker))
  );
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

function capStoredJson(sanitized: unknown, maxBytes: number): unknown {
  const serialized = JSON.stringify(sanitized);
  const byteLength = Buffer.byteLength(serialized);
  if (byteLength <= maxBytes) return sanitized;
  return {
    _truncated: true,
    originalBytes: byteLength,
    preview: serialized.slice(0, Math.max(0, maxBytes - 128)),
  };
}

export function prepareStoredJson(value: unknown, maxBytes = MAX_STORED_JSON_BYTES): unknown {
  return capStoredJson(redactSensitive(value), maxBytes);
}

export function prepareStoredRequest(value: unknown, maxBytes = MAX_STORED_JSON_BYTES): unknown {
  const sanitized = redactSensitive(value);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    return capStoredJson(sanitized, maxBytes);
  }
  const request = { ...(sanitized as Record<string, unknown>) };
  if (request.headers && typeof request.headers === 'object' && !Array.isArray(request.headers)) {
    request.headers = Object.fromEntries(
      Object.entries(request.headers as Record<string, unknown>).map(([name, item]) => [
        name,
        isSensitiveHeaderName(name) ? REDACTED : item,
      ]),
    );
  }
  return capStoredJson(request, maxBytes);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

type CurlHeaderValue = string | readonly string[] | undefined;

const bodyManagedHeaders = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'content-md5',
  'digest',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const preferredHeaderOrder = ['authorization', 'content-type', 'accept', 'x-request-id'];
const canonicalHeaderNames = new Map([
  ['authorization', 'Authorization'],
  ['content-type', 'Content-Type'],
  ['accept', 'Accept'],
  ['x-request-id', 'X-Request-Id'],
]);

function curlHeaders(
  source: Record<string, CurlHeaderValue> | undefined,
  authorization: string,
  accept?: string,
  requestId?: string,
): Array<[name: string, value: string]> {
  const headers = new Map<string, { name: string; values: string[] }>();
  for (const [name, rawValue] of Object.entries(source ?? {})) {
    const normalizedName = name.toLowerCase();
    if (!normalizedName || bodyManagedHeaders.has(normalizedName) || rawValue === undefined) {
      continue;
    }
    const values = (Array.isArray(rawValue) ? rawValue : [rawValue])
      .map((value) => value.trim())
      .filter(Boolean);
    if (!values.length) continue;
    headers.set(normalizedName, {
      name: canonicalHeaderNames.get(normalizedName) ?? name,
      values: isSensitiveHeaderName(name) ? [REDACTED] : values,
    });
  }

  headers.set('authorization', {
    name: 'Authorization',
    values: [`Bearer ${authorization}`],
  });
  if (!headers.has('content-type')) {
    headers.set('content-type', {
      name: 'Content-Type',
      values: ['application/json'],
    });
  }
  if (accept && !headers.has('accept')) {
    headers.set('accept', { name: 'Accept', values: [accept] });
  }
  if (requestId) {
    headers.set('x-request-id', { name: 'X-Request-Id', values: [requestId] });
  }

  const rank = (name: string) => {
    const index = preferredHeaderOrder.indexOf(name);
    return index === -1 ? preferredHeaderOrder.length : index;
  };
  return [...headers.entries()]
    .sort(([left], [right]) => rank(left) - rank(right) || left.localeCompare(right))
    .flatMap(([, header]) =>
      header.values.map((value): [name: string, value: string] => [header.name, value]),
    );
}

export function buildCurl(input: {
  url: string;
  body: unknown;
  authorization: string;
  method?: string;
  headers?: Record<string, CurlHeaderValue>;
  accept?: string;
  requestId?: string;
}): string {
  const body = JSON.stringify(redactSensitive(input.body), null, 2);
  const method = input.method?.trim().toUpperCase();
  const lines = [`curl${method ? ` -X ${shellQuote(method)}` : ''} ${shellQuote(input.url)} \\`];
  for (const [name, value] of curlHeaders(
    input.headers,
    input.authorization,
    input.accept,
    input.requestId,
  )) {
    lines.push(`  -H ${shellQuote(`${name}: ${value}`)} \\`);
  }
  lines.push(`  --data-raw ${shellQuote(body)}`);
  return lines.join('\n');
}

function storedCurlHeaders(value: unknown): Record<string, CurlHeaderValue> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const headers: Record<string, CurlHeaderValue> = {};
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') {
      headers[name] = item;
    } else if (Array.isArray(item) && item.every((entry) => typeof entry === 'string')) {
      headers[name] = item as string[];
    }
  }
  return headers;
}

export function buildStoredRequestCurl(
  value: unknown,
  authorization: string,
  requestId?: string,
): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const request = value as Record<string, unknown>;
  if (typeof request.url !== 'string' || !request.url) return undefined;
  const body = request.body;
  const bodyRecord =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  const headers = storedCurlHeaders(request.headers);
  return buildCurl({
    url: request.url,
    body,
    authorization,
    ...(typeof request.method === 'string' ? { method: request.method } : {}),
    ...(headers ? { headers } : {}),
    accept: bodyRecord?.stream === true ? 'text/event-stream' : 'application/json',
    ...(requestId ? { requestId } : {}),
  });
}

export function buildStoredRequestJavaScript(
  value: unknown,
  authorization: string,
): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const request = value as Record<string, unknown>;
  if (typeof request.url !== 'string' || !request.url) return undefined;
  const method =
    typeof request.method === 'string' && request.method.trim()
      ? request.method.trim().toUpperCase()
      : 'POST';
  const body = redactSensitive(request.body ?? {});
  const bodyRecord =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  const accept = bodyRecord?.stream === true ? 'text/event-stream' : 'application/json';
  const bodySource = JSON.stringify(body, null, 2)
    .split('\n')
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join('\n');

  return [
    `const apiToken = ${JSON.stringify(authorization)};`,
    '',
    `const response = await fetch(${JSON.stringify(request.url)}, {`,
    `  method: ${JSON.stringify(method)},`,
    '  headers: {',
    "    'Authorization': \`Bearer \${apiToken}\`,",
    "    'Content-Type': 'application/json',",
    `    'Accept': ${JSON.stringify(accept)},`,
    '  },',
    `  body: JSON.stringify(${bodySource}),`,
    '});',
    '',
    'if (!response.ok) throw new Error(`Request failed: ${response.status}`);',
  ].join('\n');
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
