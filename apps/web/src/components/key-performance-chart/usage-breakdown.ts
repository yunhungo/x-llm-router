/**
 * @created 2026-09-23
 * @description 整理趋势图的 Token 与费用分项及悬浮数字格式。
 * @author yunhungo
 */
import { fromUsd } from '@/features/billing/currency';

import type { KeyUsagePoint } from '@/types';

function nonnegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(value, 0) : 0;
}

export function usageBreakdown(point: KeyUsagePoint) {
  const inputTokens = nonnegative(point.inputTokens);
  const cachedInputTokens = Math.min(inputTokens, nonnegative(point.cachedTokens));
  const outputTokens = nonnegative(point.outputTokens);
  const inputCostUsd = nonnegative(point.inputCostUsd);
  const cachedInputCostUsd = nonnegative(point.cachedInputCostUsd);
  const outputCostUsd = nonnegative(point.outputCostUsd);
  const costUsd = nonnegative(point.costUsd);
  const classifiedCostUsd = inputCostUsd + cachedInputCostUsd + outputCostUsd;
  const residualCostUsd = Math.max(costUsd - classifiedCostUsd, 0);
  const roundingTolerance = Number.EPSILON * 16 * Math.max(costUsd, classifiedCostUsd, 1);

  return {
    uncachedInputTokens: inputTokens - cachedInputTokens,
    cachedInputTokens,
    outputTokens,
    inputCostUsd,
    cachedInputCostUsd,
    outputCostUsd,
    unattributedCostUsd: residualCostUsd <= roundingTolerance ? 0 : residualCostUsd,
  };
}

export function formatShare(value: number, total: number): string {
  const percent = total > 0 ? (value / total) * 100 : 0;
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(percent)}%`;
}

export function formatBreakdownCost(valueUsd: number): string {
  const amount = fromUsd(valueUsd);
  if (amount !== 0 && Math.abs(amount) < 0.01) {
    return `¥${amount.toExponential(2)}`;
  }
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}
