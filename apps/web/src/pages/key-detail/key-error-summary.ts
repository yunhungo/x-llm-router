import type { KeyErrorUsage, KeyUsageLog } from '../../types';

export interface KeyErrorGroup extends KeyErrorUsage {
  logs: KeyUsageLog[];
  hiddenCalls: number;
}

export function groupKeyErrors(
  errors: readonly KeyErrorUsage[],
  logs: readonly KeyUsageLog[],
  limit = 8,
): KeyErrorGroup[] {
  const visibleLimit = Math.max(0, Math.floor(limit));
  const logsByCode = new Map<string, KeyUsageLog[]>();

  for (const log of logs) {
    if (log.success !== false) continue;
    const code = log.errorCode ?? String(log.statusCode);
    const matchedLogs = logsByCode.get(code) ?? [];
    if (matchedLogs.length < visibleLimit) matchedLogs.push(log);
    logsByCode.set(code, matchedLogs);
  }

  return errors.map((error) => {
    const matchedLogs = logsByCode.get(error.code) ?? [];
    return {
      ...error,
      logs: matchedLogs,
      hiddenCalls: Math.max(0, error.calls - matchedLogs.length),
    };
  });
}
