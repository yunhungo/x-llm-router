/**
 * @created 2026-09-23
 * @description 以表格展示趋势图每个时段的 Token 与费用构成。
 * @author yunhungo
 */
import type { KeyUsagePoint } from '@/types';

import { formatBreakdownCost, formatShare, usageBreakdown } from './usage-breakdown';
import './UsageBreakdownTooltip.scss';

type BreakdownPoint = Pick<KeyUsagePoint, 'bucket' | 'costUsd'> & ReturnType<typeof usageBreakdown>;

const integer = new Intl.NumberFormat('zh-CN');
const categories = [
  {
    label: '输入',
    color: 'var(--chart-slate)',
    tokens: 'uncachedInputTokens',
    cost: 'inputCostUsd',
  },
  {
    label: '缓存输入',
    color: 'var(--chart-teal)',
    tokens: 'cachedInputTokens',
    cost: 'cachedInputCostUsd',
  },
  { label: '输出', color: 'var(--blue)', tokens: 'outputTokens', cost: 'outputCostUsd' },
] as const;

export function UsageBreakdownTooltip({
  active,
  payload,
  metric,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: BreakdownPoint }>;
  metric: 'tokens' | 'cost';
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  const totalTokens = point.uncachedInputTokens + point.cachedInputTokens + point.outputTokens;
  const totalCostUsd =
    point.inputCostUsd + point.cachedInputCostUsd + point.outputCostUsd + point.unattributedCostUsd;
  const title = new Date(point.bucket).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className='usage-breakdown-tooltip'>
      <div className='usage-breakdown-tooltip-heading'>
        <span>{title}</span>
        <strong>
          {metric === 'tokens'
            ? `${integer.format(totalTokens)} Token`
            : formatBreakdownCost(point.costUsd)}
        </strong>
      </div>
      <table>
        <thead>
          <tr>
            <th scope='col' />
            {categories.map((category) => (
              <th scope='col' key={category.label}>
                <span
                  className='usage-breakdown-tooltip-dot'
                  style={{ background: category.color }}
                  aria-hidden='true'
                />
                {category.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope='row'>Token 数</th>
            {categories.map((category) => {
              const value = point[category.tokens];
              return (
                <td key={category.label}>
                  {integer.format(value)}
                  <span>({formatShare(value, totalTokens)})</span>
                </td>
              );
            })}
          </tr>
          <tr>
            <th scope='row'>成本 ¥</th>
            {categories.map((category) => {
              const value = point[category.cost];
              return (
                <td key={category.label}>
                  {formatBreakdownCost(value)}
                  <span>({formatShare(value, totalCostUsd)})</span>
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
      {point.unattributedCostUsd > 0 ? (
        <div className='usage-breakdown-tooltip-unattributed'>
          <span>未拆分费用</span>
          <strong>
            {formatBreakdownCost(point.unattributedCostUsd)}
            <span>({formatShare(point.unattributedCostUsd, totalCostUsd)})</span>
          </strong>
        </div>
      ) : null}
    </div>
  );
}
