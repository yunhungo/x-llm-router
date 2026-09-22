/**
 * @created 2026-09-22
 * @description 悬停或聚焦模型时显示半透明人民币价格浮层。
 * @author yunhungo
 */
import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ModelPriceRule } from '@x-router/contracts';
import './ProviderModelBadge.scss';
export function ProviderModelBadge({
  model,
  price,
  status,
}: {
  model: string;
  price: ModelPriceRule | undefined;
  status: 'loading' | 'ready' | 'error';
}) {
  const id = useId();
  const [anchor, setAnchor] = useState<{ left: number; top: number; below: boolean }>();
  const open = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setAnchor({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - 252)),
      top: rect.top > 160 ? rect.top - 8 : rect.bottom + 8,
      below: rect.top <= 160,
    });
  };
  useEffect(() => {
    if (!anchor) return;
    const close = () => setAnchor(undefined);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [anchor]);
  return (
    <>
      <code
        className='provider-model-badge'
        tabIndex={0}
        aria-describedby={anchor ? id : undefined}
        onMouseEnter={(event) => open(event.currentTarget)}
        onMouseLeave={() => setAnchor(undefined)}
        onFocus={(event) => open(event.currentTarget)}
        onBlur={() => setAnchor(undefined)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setAnchor(undefined);
        }}
      >
        {model}
      </code>
      {anchor
        ? createPortal(
            <div
              id={id}
              role='tooltip'
              className='provider-model-price-popup'
              style={{
                left: anchor.left,
                top: anchor.top,
                transform: anchor.below ? 'none' : 'translateY(-100%)',
              }}
            >
              <strong>{model}</strong>
              {status === 'loading' ? (
                <p>价格加载中…</p>
              ) : status === 'error' ? (
                <p>价格加载失败，请刷新重试。</p>
              ) : price ? (
                <>
                  <small>人民币 / 百万 tokens</small>
                  <dl>
                    <div>
                      <dt>输入</dt>
                      <dd>¥{price.inputPerMillion}</dd>
                    </div>
                    <div>
                      <dt>缓存输入</dt>
                      <dd>¥{price.cachedInputPerMillion}</dd>
                    </div>
                    <div>
                      <dt>输出</dt>
                      <dd>¥{price.outputPerMillion}</dd>
                    </div>
                  </dl>
                </>
              ) : (
                <p>尚未配置价格</p>
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
