import type { UsageLog } from '../../types';

export const ESTIMATED_USAGE_LOG_ROW_HEIGHT = 68;
export const USAGE_LOG_PREFETCH_ROWS = 8;
export const MIN_USAGE_LOG_BATCH_SIZE = 20;
export const MAX_USAGE_LOG_BATCH_SIZE = 500;

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

export function appendUniqueUsageLogs(
  current: readonly UsageLog[],
  incoming: readonly UsageLog[],
): UsageLog[] {
  const seen = new Set(current.map((log) => log.id));
  const appended = [...current];
  for (const log of incoming) {
    if (seen.has(log.id)) continue;
    seen.add(log.id);
    appended.push(log);
  }
  return appended;
}
