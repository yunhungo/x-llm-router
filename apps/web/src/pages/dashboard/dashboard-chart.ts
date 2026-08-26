import type { UsagePoint } from '../../types';

const integer = new Intl.NumberFormat('zh-CN');
const compactInteger = new Intl.NumberFormat('zh-CN', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const AXIS_INTERVALS = 4;
const PLOT_PADDING = 2;

export function formatCallCount(calls: number): string {
  return integer.format(calls);
}

export function formatAxisCallCount(calls: number): string {
  return compactInteger.format(calls);
}

function getNiceStep(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const niceNormalized =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return niceNormalized * magnitude;
}

export function getChartMetrics(points: Pick<UsagePoint, 'calls'>[]) {
  const peak = Math.max(...points.map((point) => point.calls), 0);
  const step = getNiceStep(Math.max(peak / AXIS_INTERVALS, 1));
  const scaleMax = step * AXIS_INTERVALS;
  return {
    peak,
    scaleMax,
    ticks: Array.from({ length: AXIS_INTERVALS + 1 }, (_, index) => index * step),
    total: points.reduce((sum, point) => sum + point.calls, 0),
  };
}

export function getLinePositions(
  points: Pick<UsagePoint, 'calls'>[],
  scaleMax: number,
): Array<{ x: number; y: number }> {
  const plotSize = 100 - PLOT_PADDING * 2;
  return points.map((point, index) => {
    const ratio = Math.min(Math.max(point.calls / scaleMax, 0), 1);
    return {
      x: points.length === 1 ? 50 : PLOT_PADDING + (index / (points.length - 1)) * plotSize,
      y: PLOT_PADDING + (1 - ratio) * plotSize,
    };
  });
}

export function getAxisPosition(tick: number, scaleMax: number): number {
  const plotSize = 100 - PLOT_PADDING * 2;
  return PLOT_PADDING + (tick / scaleMax) * plotSize;
}
