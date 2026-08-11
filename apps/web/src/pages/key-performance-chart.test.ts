import { describe, expect, it } from 'vitest';

import {
  buildGroupedChartData,
  formatPerformanceValue,
  normalizePerformancePoint,
} from './key-performance-chart';

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

  it('pivots per-model buckets and uses metric-specific values', () => {
    const buckets = [
      { bucket: '2026-08-11T00:00:00.000Z' },
      { bucket: '2026-08-11T01:00:00.000Z' },
    ] as never;
    const modelPoints = [
      {
        bucket: '2026-08-11T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-4.1',
        calls: 2,
        inputTokens: 80,
        outputTokens: 20,
        cachedTokens: 40,
        costUsd: 0.01,
        averageTps: 25,
        averageTtftMs: 300,
        averageLatencyMs: 900,
      },
    ] as never;
    const series = [{ identity: 'openai\u0000gpt-4.1', dataKey: 'model_0' }];

    expect(buildGroupedChartData(buckets, modelPoints, series, 'tokens')).toEqual([
      { bucket: '2026-08-11T00:00:00.000Z', model_0: 100 },
      { bucket: '2026-08-11T01:00:00.000Z', model_0: 0 },
    ]);
    expect(buildGroupedChartData(buckets, modelPoints, series, 'cache')[0]?.model_0).toBe(50);
    expect(buildGroupedChartData(buckets, modelPoints, series, 'latency')[0]?.model_0).toBe(900);
  });
});
