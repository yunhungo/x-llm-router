import { describe, expect, it } from 'vitest';

import { formatPerformanceValue, normalizePerformancePoint } from './key-performance-chart';

describe('key performance chart formatting', () => {
  it('uses metric-specific units', () => {
    expect(formatPerformanceValue('cache', 73.25)).toBe('73.3%');
    expect(formatPerformanceValue('latency', 1250)).toBe('1250.0 ms');
    expect(formatPerformanceValue('tps', 42.4)).toBe('42.4 token/s');
    expect(formatPerformanceValue('cost', 0.000218)).toBe('$0.000218');
    expect(formatPerformanceValue('cost', 0.0000218)).toBe('$0.00002180');
  });

  it('falls back to legacy aggregate fields during rolling deploys', () => {
    const point = normalizePerformancePoint({
      bucket: '2026-08-11T00:00:00.000Z',
      calls: 4,
      tokens: 120,
      cachedTokens: 30,
      costUsd: 0.01,
      averageTtftMs: 350,
      averageTps: 20,
      averageLatencyMs: 900,
    } as never);

    expect(point.successfulCalls).toBe(4);
    expect(point.inputTokens).toBe(120);
    expect(point.cacheRate).toBe(25);
    expect(point.p10Tps).toBe(20);
    expect(point.p50TtftMs).toBe(350);
    expect(point.p99LatencyMs).toBe(900);
  });
});
