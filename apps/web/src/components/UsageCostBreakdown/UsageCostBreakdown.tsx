/**
 * @created 2026-09-23
 * @description 在调用成本上悬停或聚焦时展示费用分项。
 * @author yunhungo
 */
import { money } from '@/features/billing/currency';
import { Info } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import type { UsageLog } from '@/types';
import './UsageCostBreakdown.scss';

const integer = new Intl.NumberFormat('zh-CN');
const rate = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 });

export function UsageCostBreakdown({
  log,
}: {
  log: Pick<
    UsageLog,
    'costUsd' | 'costBreakdown' | 'inputTokens' | 'cachedInputTokens' | 'outputTokens'
  >;
}) {
  const [anchor, setAnchor] = useState<DOMRect>();
  const tooltipRef = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const breakdown = log.costBreakdown;
  const cachedTokens = Math.min(log.inputTokens, log.cachedInputTokens);
  const parts = [
    {
      label: '输入',
      tokens: Math.max(log.inputTokens - cachedTokens, 0),
      price: breakdown?.inputPerMillionCny,
      cost: breakdown?.inputCostUsd,
    },
    {
      label: '缓存输入',
      tokens: cachedTokens,
      price: breakdown?.cachedInputPerMillionCny,
      cost: breakdown?.cachedInputCostUsd,
    },
    {
      label: '输出',
      tokens: log.outputTokens,
      price: breakdown?.outputPerMillionCny,
      cost: breakdown?.outputCostUsd,
    },
  ];

  useLayoutEffect(() => {
    if (!anchor || !tooltipRef.current) return;
    const tooltip = tooltipRef.current;
    const height = tooltip.getBoundingClientRect().height;
    const top =
      anchor.bottom + height + 12 <= window.innerHeight
        ? anchor.bottom + 8
        : anchor.top - height - 8;
    tooltip.style.top = `${Math.max(12, Math.min(top, window.innerHeight - height - 12))}px`;
  }, [anchor]);

  useEffect(() => {
    if (!anchor) return;
    const dismiss = () => setAnchor(undefined);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [anchor]);

  const show = (element: HTMLButtonElement) => setAnchor(element.getBoundingClientRect());
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape') setAnchor(undefined);
  };
  const width = Math.min(320, window.innerWidth - 24);
  const left = anchor
    ? Math.max(
        12,
        Math.min(anchor.left + anchor.width / 2 - width / 2, window.innerWidth - width - 12),
      )
    : 0;

  return (
    <>
      <button
        type='button'
        className='usage-cost-trigger'
        aria-label={`查看费用构成，总计 ${money.format(log.costUsd)}`}
        aria-describedby={anchor ? tooltipId : undefined}
        onMouseEnter={(event) => show(event.currentTarget)}
        onMouseLeave={() => setAnchor(undefined)}
        onFocus={(event) => show(event.currentTarget)}
        onBlur={() => setAnchor(undefined)}
        onKeyDown={onKeyDown}
        onClick={(event) => {
          event.stopPropagation();
          show(event.currentTarget);
        }}
      >
        <span>{money.format(log.costUsd)}</span>
        <Info size={13} aria-hidden='true' />
      </button>
      {anchor
        ? createPortal(
            <div
              id={tooltipId}
              ref={tooltipRef}
              role='tooltip'
              className='usage-cost-tooltip'
              style={{ left, top: anchor.bottom + 8, width }}
            >
              <div className='usage-cost-tooltip-heading'>
                <div>
                  <strong>费用构成</strong>
                  <span>按实际调用 Token 计费</span>
                </div>
                <span className='usage-cost-tooltip-currency'>CNY</span>
              </div>
              <div className='usage-cost-tooltip-parts'>
                {parts.map((part) => (
                  <div className='usage-cost-tooltip-part' key={part.label}>
                    <div>
                      <strong>{part.label}</strong>
                      <span>
                        {integer.format(part.tokens)} Token
                        {part.price !== undefined
                          ? ` × ¥${rate.format(part.price)} / 百万 Token`
                          : ''}
                      </span>
                    </div>
                    <strong>{part.cost !== undefined ? money.format(part.cost) : '—'}</strong>
                  </div>
                ))}
              </div>
              <div className='usage-cost-tooltip-total'>
                <span>合计</span>
                <strong>{money.format(log.costUsd)}</strong>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
