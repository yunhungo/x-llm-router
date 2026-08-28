import { describe, expect, it } from 'vitest';

import type { UsageLog } from '../../types';
import {
  appendUniqueUsageLogs,
  calculateUsageLogBatchSize,
  createDefaultUsageLogFilters,
  DEFAULT_USAGE_LOG_WINDOW_DAYS,
  ESTIMATED_USAGE_LOG_ROW_HEIGHT,
  MIN_USAGE_LOG_BATCH_SIZE,
  shouldLoadMoreUsageLogs,
  usageLogFilterSearchParams,
  usageLogTimeRangeError,
  USAGE_LOG_PREFETCH_ROWS,
} from './usage-log-pagination';

function usageLog(id: string): UsageLog {
  return {
    id,
    requestId: `request-${id}`,
    apiKeyId: null,
    endpoint: 'responses',
    requestedModel: 'gpt-5',
    model: 'gpt-5',
    callStatus: 'completed',
    statusCode: 200,
    success: true,
    inputTokens: 1,
    cachedInputTokens: 0,
    outputTokens: 1,
    reasoningTokens: null,
    visibleOutputTokens: null,
    totalTokens: 2,
    costUsd: 0,
    latencyMs: 100,
    timeToFirstTokenMs: 20,
    timeToFirstVisibleTokenMs: 20,
    errorCode: null,
    createdAt: '2026-08-28T00:00:00.000Z',
    apiKeyName: null,
    providerName: null,
    detailAvailable: false,
  };
}

describe('usage log filters', () => {
  it('defaults to the seven days ending now', () => {
    const now = new Date('2026-08-28T12:00:00.000Z');
    const filters = createDefaultUsageLogFilters(now);

    expect(filters.to).toBe(now.toISOString());
    expect(new Date(filters.to).getTime() - new Date(filters.from).getTime()).toBe(
      DEFAULT_USAGE_LOG_WINDOW_DAYS * 86_400_000,
    );
  });

  it('serializes search and server-side filters with the selected time window', () => {
    const params = usageLogFilterSearchParams({
      ...createDefaultUsageLogFilters(new Date('2026-08-28T12:00:00.000Z')),
      search: ' request-123 ',
      status: 'failed',
      model: 'gpt-5',
      endpoint: 'responses',
    });

    expect(params.get('from')).toBe('2026-08-21T12:00:00.000Z');
    expect(params.get('to')).toBe('2026-08-28T12:00:00.000Z');
    expect(params.get('search')).toBe('request-123');
    expect(params.get('status')).toBe('failed');
    expect(params.get('model')).toBe('gpt-5');
    expect(params.get('endpoint')).toBe('responses');
  });

  it('rejects incomplete and reversed time windows before requesting', () => {
    expect(usageLogTimeRangeError({ from: '', to: '' })).toContain('完整');
    expect(
      usageLogTimeRangeError({
        from: '2026-08-28T12:00:00.000Z',
        to: '2026-08-21T12:00:00.000Z',
      }),
    ).toContain('早于');
  });
});

describe('usage log pagination', () => {
  it('requests more than two visible pages for each batch', () => {
    const viewportHeight = ESTIMATED_USAGE_LOG_ROW_HEIGHT * 12;

    expect(calculateUsageLogBatchSize(viewportHeight)).toBe(12 * 2 + USAGE_LOG_PREFETCH_ROWS);
    expect(calculateUsageLogBatchSize(viewportHeight)).toBeGreaterThan(12 * 2);
  });

  it('keeps a useful minimum batch for short or unavailable viewports', () => {
    expect(calculateUsageLogBatchSize(0)).toBe(MIN_USAGE_LOG_BATCH_SIZE);
    expect(calculateUsageLogBatchSize(200)).toBe(MIN_USAGE_LOG_BATCH_SIZE);
  });

  it('prefetches only after scrolling within one visible page of the end', () => {
    expect(shouldLoadMoreUsageLogs({ scrollHeight: 2_400, scrollTop: 0, clientHeight: 800 })).toBe(
      false,
    );
    expect(
      shouldLoadMoreUsageLogs({ scrollHeight: 2_400, scrollTop: 800, clientHeight: 800 }),
    ).toBe(true);
    expect(shouldLoadMoreUsageLogs({ scrollHeight: 800, scrollTop: 0, clientHeight: 800 })).toBe(
      false,
    );
  });

  it('appends cursor pages without duplicating boundary rows', () => {
    expect(
      appendUniqueUsageLogs(
        [usageLog('one'), usageLog('two')],
        [usageLog('two'), usageLog('three')],
      ).map((log) => log.id),
    ).toEqual(['one', 'two', 'three']);
  });
});
