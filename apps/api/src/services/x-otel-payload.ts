/**
 * @created 2026-10-22
 * @description 在 UTF-8 字节预算内保留最近对话和工具标识，仅对长值和省略项作显式标记。
 * @author yunhungo
 */
import type { Attributes, AttributeValue } from '@opentelemetry/api';

export const XOTEL_CONTENT_BYTES = 24 * 1024;
export const XOTEL_METADATA_BYTES = 12 * 1024;
const LEAF_BYTES = 2 * 1024;
const MIN_VALUE_BYTES = 128;
const MAX_DEPTH = 12;
const MAX_ITEMS = 64;
const MAX_NODES = 2048;
const ITEM_BYTES = 8 * 1024;
const STRUCTURE_KEYS = [
  'type',
  'role',
  'id',
  'call_id',
  'tool_call_id',
  'tool_use_id',
  'name',
  'model',
  'messages',
  'input',
  'output',
  'tool_calls',
  'function',
  'content',
  'arguments',
] as const;
const KEY_PRIORITY = new Map<string, number>(STRUCTURE_KEYS.map((key, index) => [key, index]));
const INPUT_ATTRIBUTES = ['langfuse.observation.input', 'langfuse.trace.input'];
const OUTPUT_ATTRIBUTES = ['langfuse.observation.output', 'langfuse.trace.output'];
const REQUIRED_METADATA = new Set([
  'langfuse.trace.metadata.apiKeyId',
  'langfuse.observation.type',
  'langfuse.observation.model.name',
  'langfuse.observation.usage_details',
  'langfuse.observation.cost_details',
  'langfuse.observation.completion_start_time',
  'langfuse.observation.metadata.timeToFirstTokenMs',
  'langfuse.observation.metadata.timeToFirstVisibleTokenMs',
  'langfuse.observation.metadata.toolResultSource',
  'langfuse.observation.metadata.inputSource',
  'langfuse.observation.metadata.outputSource',
  'langfuse.trace.name',
  'session.id',
  'user.id',
]);

function serialized(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(serialized(value), 'utf8');
}

function safePrefix(value: string, end: number): string {
  const last = value.charCodeAt(end - 1);
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}

function previewMarker(
  value: unknown,
  budget: number,
  json = serialized(value),
): Record<string, unknown> {
  const source = typeof value === 'string' ? value : json;
  const base = { xotel_truncated: true, original_json_bytes: Buffer.byteLength(json, 'utf8') };
  let low = 0;
  let high = Math.min(source.length, LEAF_BYTES);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = { ...base, preview: safePrefix(source, middle) };
    if (jsonBytes(candidate) <= Math.min(budget, LEAF_BYTES)) low = middle;
    else high = middle - 1;
  }
  return { ...base, preview: safePrefix(source, low) };
}

interface LimitContext {
  nodes: number;
}

function boundedValue(value: unknown, budget: number, context: LimitContext, depth = 0): unknown {
  context.nodes += 1;
  if (depth >= MAX_DEPTH || context.nodes > MAX_NODES) return previewMarker(value, budget);
  if (typeof value === 'string') {
    const leafBudget = Math.min(budget, LEAF_BYTES);
    return jsonBytes(value) <= leafBudget ? value : previewMarker(value, leafBudget);
  }
  if (value === null || typeof value !== 'object') return value ?? null;

  if (Array.isArray(value)) {
    const retained: unknown[] = [];
    let childrenBytes = 0;
    for (let index = value.length - 1; index >= 0 && retained.length < MAX_ITEMS; index -= 1) {
      const omitted = { type: 'xotel_omitted', omitted_items: index };
      const reserve = index > 0 ? jsonBytes(omitted) + 1 : 0;
      const available = budget - 2 - childrenBytes - retained.length - reserve;
      if (available < MIN_VALUE_BYTES || context.nodes >= MAX_NODES) break;
      const item = boundedValue(value[index], Math.min(available, ITEM_BYTES), context, depth + 1);
      retained.push(item);
      childrenBytes += jsonBytes(item);
    }
    const omittedCount = value.length - retained.length;
    retained.reverse();
    if (omittedCount > 0) retained.unshift({ type: 'xotel_omitted', omitted_items: omittedCount });
    return retained;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(
    (left, right) => (KEY_PRIORITY.get(left) ?? 100) - (KEY_PRIORITY.get(right) ?? 100),
  );
  const entries: Array<[string, unknown]> = [];
  let childrenBytes = 0;
  for (const key of keys.slice(0, MAX_ITEMS)) {
    const keyBytes = jsonBytes(key) + 1;
    const reserve = jsonBytes({ xotel_omitted_fields: keys.length }) - 1;
    const available = budget - 2 - childrenBytes - entries.length - keyBytes - reserve;
    if (available < MIN_VALUE_BYTES || context.nodes >= MAX_NODES) break;
    const child = boundedValue(record[key], available, context, depth + 1);
    entries.push([key, child]);
    childrenBytes += keyBytes + jsonBytes(child);
  }
  const omittedCount = keys.length - entries.length;
  if (omittedCount > 0) entries.push(['xotel_omitted_fields', omittedCount]);
  return Object.fromEntries(entries);
}

/** Returns an OTLP-compatible serialized value; normal content stays byte-for-byte unchanged. */
export function limitXotelPayload(
  { data }: { data: unknown },
  budget = XOTEL_CONTENT_BYTES,
): unknown {
  if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') <= budget) return data;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    value = data;
  }
  try {
    const bounded = boundedValue(value, budget, { nodes: 0 });
    const result = serialized(bounded);
    // This also covers pathological object keys and serialization overhead.
    return Buffer.byteLength(result, 'utf8') <= budget
      ? result
      : serialized(previewMarker(value, budget));
  } catch {
    // JSON.parse accepts nesting deeper than JSON.stringify can safely serialize.
    return serialized(previewMarker(null, budget, data));
  }
}

function boundedAttribute(value: AttributeValue): AttributeValue {
  if (jsonBytes(value) <= LEAF_BYTES) return value;
  const bounded = boundedValue(value, LEAF_BYTES, { nodes: 0 });
  return typeof bounded === 'string' ? bounded : serialized(bounded);
}

/** Budgets all metadata together and keeps routing, usage, cost and TTFT fields first. */
export function limitXotelSpanAttributes(original: Attributes): Attributes {
  const attributes: Attributes = {};
  const bodyKeys = new Set([...INPUT_ATTRIBUTES, ...OUTPUT_ATTRIBUTES]);
  for (const candidates of [INPUT_ATTRIBUTES, OUTPUT_ATTRIBUTES]) {
    const present = candidates.filter((key) => original[key] !== undefined);
    const budget = Math.floor(XOTEL_CONTENT_BYTES / Math.max(1, present.length));
    for (const key of present) {
      const limited = limitXotelPayload({ data: original[key] }, budget);
      attributes[key] = typeof limited === 'string' ? limited : original[key];
    }
  }

  const entries = Object.entries(original)
    .filter(([key, value]) => !bodyKeys.has(key) && value !== undefined)
    .sort(
      ([left], [right]) =>
        Number(REQUIRED_METADATA.has(right)) - Number(REQUIRED_METADATA.has(left)),
    );
  let metadata: Attributes = {};
  const selected = entries.slice(0, MAX_NODES);
  let omittedCount = entries.length - selected.length;
  for (const [key, value] of selected) {
    if (value === undefined) continue;
    const candidate = { ...metadata, [key]: boundedAttribute(value) };
    if (jsonBytes({ ...candidate, xotel_omitted_fields: entries.length }) > XOTEL_METADATA_BYTES) {
      omittedCount += 1;
      continue;
    }
    metadata = candidate;
  }
  if (omittedCount > 0) metadata.xotel_omitted_fields = omittedCount;
  return { ...attributes, ...metadata };
}
