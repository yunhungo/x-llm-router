import { describe, expect, it } from 'vitest';

import type { UsageLog } from '../../types';
import {
  appendUniqueUsageLogs,
  calculateUsageLogBatchSize,
  ESTIMATED_USAGE_LOG_ROW_HEIGHT,
  MIN_USAGE_LOG_BATCH_SIZE,
  shouldLoadMoreUsageLogs,
  USAGE_LOG_PREFETCH_ROWS,
} from './usage-pagination';

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
