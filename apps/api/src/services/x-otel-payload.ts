/**
 * @created 2026-10-22
 * @description 为 X-Otel 限制单个观测内容字段并保留明确的 UTF-8 截断说明。
 * @author yunhungo
 */
const FIELD_LIMIT_BYTES = 12 * 1024;
const PREVIEW_LIMIT_BYTES = 4 * 1024;

export function limitXotelPayload({ data }: { data: unknown }): unknown {
  if (typeof data !== 'string') return data;
  const originalBytes = Buffer.byteLength(data, 'utf8');
  if (originalBytes <= FIELD_LIMIT_BYTES) return data;

  // A bounded prefix avoids allocating a second copy of a potentially large prompt.
  const bytes = Buffer.from(data.slice(0, PREVIEW_LIMIT_BYTES + 2), 'utf8');
  let end = PREVIEW_LIMIT_BYTES;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return JSON.stringify({
    truncated: true,
    reason: 'x_otel_field_limit',
    original_bytes: originalBytes,
    field_limit_bytes: FIELD_LIMIT_BYTES,
    retained_range_bytes: [0, end],
    preview: bytes.subarray(0, end).toString('utf8'),
  });
}
