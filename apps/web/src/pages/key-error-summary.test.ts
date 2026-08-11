import { describe, expect, it } from 'vitest';

import type { KeyUsageLog } from '../types';
import { groupKeyErrors } from './key-error-summary';

function usageLog(overrides: Partial<KeyUsageLog>): KeyUsageLog {
  return {
    id: 'log-id',
    requestId: 'request-id',
    endpoint: 'responses',
    requestedModel: 'gpt-5',
    model: 'gpt-5',
    statusCode: 500,
    success: false,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    latencyMs: 100,
    timeToFirstTokenMs: null,
    errorCode: null,
    createdAt: '2026-08-11T08:00:00.000Z',
    providerName: 'OpenAI',
    detailAvailable: true,
    tps: null,
    ...overrides,
  };
}

describe('key error summary', () => {
  it('matches failed logs by error code first and falls back to status code', () => {
    const groups = groupKeyErrors(
      [
        { code: 'rate_limit_exceeded', calls: 3 },
        { code: '500', calls: 2 },
        { code: 'no_recent_log', calls: 4 },
      ],
      [
        usageLog({
          id: 'rate-newest',
          statusCode: 429,
          errorCode: 'rate_limit_exceeded',
          createdAt: '2026-08-11T08:03:00.000Z',
        }),
        usageLog({
          id: 'successful-is-ignored',
          statusCode: 500,
          success: true,
          createdAt: '2026-08-11T08:02:30.000Z',
        }),
        usageLog({
          id: 'status-fallback',
          statusCode: 500,
          errorCode: null,
          createdAt: '2026-08-11T08:02:00.000Z',
        }),
        usageLog({
          id: 'rate-older',
          statusCode: 429,
          errorCode: 'rate_limit_exceeded',
          createdAt: '2026-08-11T08:01:00.000Z',
        }),
        usageLog({
          id: 'error-code-wins-over-status',
          statusCode: 502,
          errorCode: '500',
          createdAt: '2026-08-11T08:00:00.000Z',
        }),
      ],
    );

    expect(groups.map(({ code }) => code)).toEqual(['rate_limit_exceeded', '500', 'no_recent_log']);
    expect(groups[0]?.logs.map(({ id }) => id)).toEqual(['rate-newest', 'rate-older']);
    expect(groups[0]?.hiddenCalls).toBe(1);
    expect(groups[1]?.logs.map(({ id }) => id)).toEqual([
      'status-fallback',
      'error-code-wins-over-status',
    ]);
    expect(groups[1]?.hiddenCalls).toBe(0);
    expect(groups[2]).toMatchObject({ logs: [], hiddenCalls: 4 });
  });

  it('keeps the newest eight matching logs and reports calls outside the visible sample', () => {
    const logs = Array.from({ length: 10 }, (_, index) =>
      usageLog({
        id: `log-${index}`,
        statusCode: 429,
        errorCode: 'rate_limit_exceeded',
        createdAt: new Date(Date.UTC(2026, 7, 11, 8, 10 - index)).toISOString(),
      }),
    );

    const [group] = groupKeyErrors([{ code: 'rate_limit_exceeded', calls: 12 }], logs);

    expect(group?.logs).toHaveLength(8);
    expect(group?.logs.map(({ id }) => id)).toEqual(
      Array.from({ length: 8 }, (_, index) => `log-${index}`),
    );
    expect(group?.hiddenCalls).toBe(4);
  });
});
