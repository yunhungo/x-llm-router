import { relativeDateRange } from '../../date-range';
export { dateRangeError as usageLogTimeRangeError } from '../../date-range';
import type { UsageLog } from '../../types';

export const ESTIMATED_USAGE_LOG_ROW_HEIGHT = 68;
export const USAGE_LOG_PREFETCH_ROWS = 8;
export const MIN_USAGE_LOG_BATCH_SIZE = 20;
export const MAX_USAGE_LOG_BATCH_SIZE = 500;
export const DEFAULT_USAGE_LOG_WINDOW_DAYS = 7;

export type UsageLogStatusFilter = 'all' | 'active' | 'success' | 'failed';

export interface UsageLogFiltersState {
  search: string;
  status: UsageLogStatusFilter;
  model: string;
  endpoint: string;
  from: string;
  to: string;
}

export function createDefaultUsageLogFilters(now = new Date()): UsageLogFiltersState {
  return {
    search: '',
    status: 'all',
    model: 'all',
    endpoint: 'all',
    ...relativeDateRange(DEFAULT_USAGE_LOG_WINDOW_DAYS, now),
  };
}

export function datetimeLocalValue(value: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function datetimeLocalIso(value: string): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

export function usageLogFilterSearchParams(filters: UsageLogFiltersState): URLSearchParams {
  const params = new URLSearchParams({ from: filters.from, to: filters.to });
  const search = filters.search.trim();
  if (search) params.set('search', search);
  if (filters.status !== 'all') params.set('status', filters.status);
  if (filters.model !== 'all') params.set('model', filters.model);
  if (filters.endpoint !== 'all') params.set('endpoint', filters.endpoint);
  return params;
}

export function calculateUsageLogBatchSize(viewportHeight: number): number {
  const normalizedHeight =
    Number.isFinite(viewportHeight) && viewportHeight > 0
      ? viewportHeight
      : ESTIMATED_USAGE_LOG_ROW_HEIGHT;
  const visibleRows = Math.max(1, Math.ceil(normalizedHeight / ESTIMATED_USAGE_LOG_ROW_HEIGHT));
  return Math.min(
    MAX_USAGE_LOG_BATCH_SIZE,
    Math.max(MIN_USAGE_LOG_BATCH_SIZE, visibleRows * 2 + USAGE_LOG_PREFETCH_ROWS),
  );
}

export function shouldLoadMoreUsageLogs({
  scrollHeight,
  scrollTop,
  clientHeight,
}: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean {
  if (clientHeight <= 0 || scrollHeight <= clientHeight) return false;
  const remaining = scrollHeight - scrollTop - clientHeight;
  return remaining <= Math.max(clientHeight, ESTIMATED_USAGE_LOG_ROW_HEIGHT);
}

export function appendUniqueUsageLogs<TLog extends Pick<UsageLog, 'id'>>(
  current: readonly TLog[],
  incoming: readonly TLog[],
): TLog[] {
  const seen = new Set(current.map((log) => log.id));
  const appended = [...current];
  for (const log of incoming) {
    if (seen.has(log.id)) continue;
    seen.add(log.id);
    appended.push(log);
  }
  return appended;
}
