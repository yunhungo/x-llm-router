/**
 * @created 2026-08-26
 * @description 负责上游模型价格规则的维护与计费。
 * @author yunhungo
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import type { ModelPriceRule } from '@x-router/contracts';
import { ApiError } from '@/api';
import { Button, ComboboxInput, Field, Input, Skeleton, Toast } from '@/components/ui';
import type { Provider } from '@/types';
import {
  loadModelPrices,
  upsertModelPrice,
  deleteModelPrice,
} from '@/features/model-pricing/model-pricing.api';
import {
  emptyPriceDraft,
  parsePriceValues,
  priceDraft,
  priceModelSuggestions,
  priceRuleKey,
} from '@/features/model-pricing/model-pricing.model';
import './ModelPricingSettings.scss';

export function ModelPricingSettings({
  connectionId,
  providers,
  onPricesChange,
}: {
  connectionId: string;
  providers: Provider[];
  onPricesChange?: () => void;
}) {
  const [prices, setPrices] = useState<ModelPriceRule[]>();
  const [draft, setDraft] = useState({
    ...emptyPriceDraft,
    provider: providers[0]?.provider ?? '*',
  });
  const [editing, setEditing] = useState<ModelPriceRule>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dismiss = useCallback(() => setNotice(''), []);
  const reload = useCallback(async () => {
    setPrices((await loadModelPrices(connectionId)).prices);
  }, [connectionId]);
  useEffect(() => {
    let active = true;
    void loadModelPrices(connectionId)
      .then((result) => {
        if (active) setPrices(result.prices);
      })
      .catch((caught: unknown) => {
        if (active)
          setError(caught instanceof ApiError ? caught.message : '价格加载失败，请重试。');
      });
    return () => {
      active = false;
    };
  }, [connectionId]);
  const reset = () => {
    setEditing(undefined);
    setDraft({ ...emptyPriceDraft, provider: providers[0]?.provider ?? '*' });
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const values = parsePriceValues(draft);
    if (!draft.modelPattern.trim() || !values) {
      setError('请输入模型名和完整的非负价格。');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await upsertModelPrice(connectionId, {
        provider: draft.provider,
        modelPattern: draft.modelPattern.trim(),
        currency: 'CNY',
        inputPerMillion: values[0],
        cachedInputPerMillion: values[1],
        outputPerMillion: values[2],
      });
      await reload();
      onPricesChange?.();
      reset();
      setNotice('模型价格已保存。');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '保存失败，请重试。');
    } finally {
      setBusy(false);
    }
  };
  const remove = async (price: ModelPriceRule) => {
    if (!window.confirm(`确定删除“${price.modelPattern}”的价格吗？`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await deleteModelPrice(connectionId, price);
      await reload();
      onPricesChange?.();
      if (editing === price) reset();
      setNotice('模型价格已删除。');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '删除失败，请重试。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className='model-pricing-editor'>
      <p className='model-pricing-editor__note'>
        人民币 / 百万 tokens · 所有关联 API Key 共用此上游价格
      </p>
      <form onSubmit={(event) => void save(event)}>
        <Field
          label='模型名'
          hint={editing ? '正在修改此模型的价格。' : '输入完整模型名；也可沿用已有的模型前缀规则。'}
        >
          <ComboboxInput
            value={draft.modelPattern}
            options={priceModelSuggestions(providers, '*')}
            disabled={busy || Boolean(editing)}
            onChange={(event) => setDraft({ ...draft, modelPattern: event.target.value })}
            placeholder='例如 deepseek-flash'
            required
          />
        </Field>
        <div className='model-pricing-editor__fields'>
          {(
            [
              ['inputPerMillion', '输入价格'],
              ['cachedInputPerMillion', '缓存输入价格'],
              ['outputPerMillion', '输出价格'],
            ] as const
          ).map(([field, label]) => (
            <Field key={field} label={label}>
              <Input
                type='number'
                min='0'
                step='0.000001'
                required
                disabled={busy}
                value={draft[field]}
                onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
              />
            </Field>
          ))}
        </div>
        {error ? (
          <div className='form-error' role='alert'>
            {error}
            {!prices ? (
              <Button
                type='button'
                onClick={() => {
                  setError('');
                  void reload().catch(() => setError('价格加载失败，请重试。'));
                }}
              >
                重试
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className='model-pricing-editor__actions'>
          {editing ? (
            <Button type='button' variant='secondary' disabled={busy} onClick={reset}>
              取消修改
            </Button>
          ) : null}
          <Button type='submit' loading={busy}>
            {editing ? '确定修改' : '确定'}
          </Button>
        </div>
      </form>
      <div className='model-pricing-editor__list'>
        <h3>已配置价格</h3>
        {!prices ? (
          <Skeleton height={100} />
        ) : !prices.length ? (
          <p className='panel-note'>尚未配置，输入模型名和价格后点击确定。</p>
        ) : (
          prices.map((price) => (
            <div
              className='model-pricing-editor__record'
              key={priceRuleKey(price.provider, price.modelPattern)}
            >
              <div>
                <strong>{price.modelPattern}</strong>
                <p>
                  输入 ¥{price.inputPerMillion} · 缓存 ¥{price.cachedInputPerMillion} · 输出 ¥
                  {price.outputPerMillion}
                </p>
              </div>
              <div className='model-pricing-editor__record-actions'>
                <Button
                  variant='ghost'
                  disabled={busy}
                  aria-label={`修改 ${price.modelPattern} 价格`}
                  onClick={() => {
                    setEditing(price);
                    setDraft({
                      ...priceDraft(price),
                      provider: price.provider,
                      modelPattern: price.modelPattern,
                    });
                    setError('');
                  }}
                >
                  <Pencil size={14} />
                  修改
                </Button>
                <Button
                  variant='ghost'
                  disabled={busy}
                  aria-label={`删除 ${price.modelPattern} 价格`}
                  onClick={() => void remove(price)}
                >
                  <Trash2 size={14} />
                  删除
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
      {notice ? (
        <Toast tone='success' onDismiss={dismiss}>
          {notice}
        </Toast>
      ) : null}
    </div>
  );
}
