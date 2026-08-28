interface RequestSnapshot {
  method?: unknown;
  url?: unknown;
  body?: unknown;
}

function requestSnapshot(value: unknown): RequestSnapshot {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RequestSnapshot)
    : {};
}

export function requestJson(value: unknown): string {
  return value === null || value === undefined ? '暂无数据' : JSON.stringify(value, null, 2);
}

export function requestJavaScript(value: unknown, apiToken: string): string {
  const request = requestSnapshot(value);
  const method =
    typeof request.method === 'string' && request.method.trim()
      ? request.method.trim().toUpperCase()
      : 'POST';
  const url = typeof request.url === 'string' ? request.url : '';
  const body = request.body ?? {};
  const accept =
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    (body as Record<string, unknown>).stream === true
      ? 'text/event-stream'
      : 'application/json';

  return [
    `const apiToken = ${JSON.stringify(apiToken)};`,
    '',
    `const response = await fetch(${JSON.stringify(url)}, {`,
    `  method: ${JSON.stringify(method)},`,
    '  headers: {',
    "    'Authorization': `Bearer ${apiToken}`,",
    "    'Content-Type': 'application/json',",
    `    'Accept': ${JSON.stringify(accept)},`,
    '  },',
    `  body: JSON.stringify(${JSON.stringify(body, null, 2)
      .split('\n')
      .map((line, index) => (index === 0 ? line : `  ${line}`))
      .join('\n')}),`,
    '});',
    '',
    'if (!response.ok) throw new Error(`Request failed: ${response.status}`);',
  ].join('\n');
}

export const clientRequestJson = requestJson;

export function clientRequestJavaScript(value: unknown): string {
  return requestJavaScript(value, '<ROUTER_API_KEY>');
}
