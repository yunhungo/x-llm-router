/**
 * @created 2026-09-22
 * @description 加载当前上游价格并为可用模型显示价格提示。
 * @author yunhungo
 */
import { useEffect, useState } from 'react';
import type { ModelPriceRule } from '@x-router/contracts';
import type { Provider } from '@/types';
import { loadModelPrices } from '@/features/model-pricing/model-pricing.api';
import { ProviderModelBadge } from '../ProviderModelBadge/ProviderModelBadge';
import './ProviderModelList.scss';
export function ProviderModelList({
  provider,
  revision,
}: {
  provider: Provider;
  revision: number;
}) {
  const [prices, setPrices] = useState<ModelPriceRule[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    let active = true;
    setStatus('loading');
    void loadModelPrices(provider.id)
      .then((result) => {
        if (active) {
          setPrices(result.prices);
          setStatus('ready');
        }
      })
      .catch(() => {
        if (active) setStatus('error');
      });
    return () => {
      active = false;
    };
  }, [provider.id, revision]);
  return (
    <div className='provider-model-list'>
      {' '}
      {provider.models.map((model) => {
        const price = prices
          .filter(
            (p) =>
              (p.provider === provider.provider || p.provider === '*') &&
              model.startsWith(p.modelPattern),
          )
          .sort(
            (a, b) =>
              Number(b.provider === provider.provider) - Number(a.provider === provider.provider) ||
              b.modelPattern.length - a.modelPattern.length,
          )[0];
        return <ProviderModelBadge key={model} model={model} price={price} status={status} />;
      })}
    </div>
  );
}
