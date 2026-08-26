import { describe, expect, it } from 'vitest';

import { formatCallCount, getChartMetrics, getLinePositions } from './dashboard-chart';

describe('dashboard chart', () => {
  it('keeps an all-zero series at a zero peak with a safe scale', () => {
    const points = Array.from({ length: 14 }, () => ({ calls: 0 }));

    const metrics = getChartMetrics(points);

    expect(metrics).toEqual({
      peak: 0,
      scaleMax: 4,
      ticks: [0, 1, 2, 3, 4],
      total: 0,
    });
    expect(getLinePositions(points, metrics.scaleMax).map((position) => position.y)).toEqual(
      Array(14).fill(98),
    );
  });

  it('preserves totals, proportions, and labels for large call counts', () => {
    const firstCalls = 1_000_000_000;
    const peakCalls = 4_000_000_000;
    const points = [{ calls: firstCalls }, { calls: peakCalls }];

    const metrics = getChartMetrics(points);

    expect(metrics).toEqual({
      peak: 4_000_000_000,
      scaleMax: 4_000_000_000,
      ticks: [0, 1_000_000_000, 2_000_000_000, 3_000_000_000, 4_000_000_000],
      total: 5_000_000_000,
    });
    expect(getLinePositions(points, metrics.scaleMax)).toEqual([
      { x: 2, y: 74 },
      { x: 98, y: 2 },
    ]);
    expect(formatCallCount(metrics.peak)).toBe('4,000,000,000');
  });
});
