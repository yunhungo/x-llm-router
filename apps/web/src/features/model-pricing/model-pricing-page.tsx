import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, Plus, Save, Trash2 } from 'lucide-react';

import type { ModelPriceRule } from '@x-router/contracts';

import { ApiError } from '../../api';
import {
  Button,
  ComboboxInput,
  Field,
  Input,
  Modal,
  PageHeader,
  Skeleton,
} from '../../components/ui';
import type { Provider } from '../../types';
import {
  deleteModelPrice,
  loadModelPrices,
  loadModelPricing,
  upsertModelPrice,
} from './model-pricing.api';
import {
  emptyPriceDraft,
  parsePriceValues,
  priceDraft,
  priceModelSuggestions,
  priceRuleKey,
  type NewPriceDraft,
  type PriceDraft,
} from './model-pricing.model';
import './model-pricing.css';

const fullDate = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function ModelPricingPage() {
  const [prices, setPrices] = useState<ModelPriceRule[]>();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [drafts, setDrafts] = useState<Record<string, PriceDraft>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState('');
  const [saved, setSaved] = useState('');
  const [deleting, setDeleting] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [newPrice, setNewPrice] = useState<NewPriceDraft>(emptyPriceDraft);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState('');

  const applyPrices = useCallback((nextPrices: ModelPriceRule[]) => {
    setPrices(nextPrices);
    setDrafts(
      Object.fromEntries(
        nextPrices.map((price) => [
          priceRuleKey(price.provider, price.modelPattern),
          priceDraft(price),
        ]),
      ),
    );
  }, []);

  const reloadPrices = useCallback(async () => {
    const response = await loadModelPrices();
    applyPrices(response.prices);
  }, [applyPrices]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void loadModelPricing()
      .then((response) => {
        if (!active) return;
        applyPrices(response.prices);
        setProviders(response.providers);
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setError(caught instanceof ApiError ? caught.message : '模型价格加载失败。');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [applyPrices]);

  const providerOptions = useMemo(
    () =>
      [
        ...new Set([
          ...providers.map((provider) => provider.provider),
          ...(prices ?? []).map((price) => price.provider),
        ]),
      ]
        .filter((provider) => provider !== '*')
        .sort((left, right) => left.localeCompare(right)),
    [prices, providers],
  );
  const modelOptions = useMemo(
    () => priceModelSuggestions(providers, newPrice.provider),
    [newPrice.provider, providers],
  );

  const savePrice = async (price: ModelPriceRule) => {
    const key = priceRuleKey(price.provider, price.modelPattern);
    const values = drafts[key] ? parsePriceValues(drafts[key]) : undefined;
    if (!values) {
      setError('价格必须填写完整，并且是大于或等于 0 的数字。');
      return;
    }
    setSaving(key);
    setSaved('');
    setError('');
    try {
      await upsertModelPrice({
        provider: price.provider,
        modelPattern: price.modelPattern,
        inputPerMillion: values[0],
        cachedInputPerMillion: values[1],
        outputPerMillion: values[2],
      });
      await reloadPrices();
      setSaved(key);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '价格保存失败。');
    } finally {
      setSaving('');
    }
  };

  const createPrice = async (event: FormEvent) => {
    event.preventDefault();
    const provider = newPrice.provider.trim();
    const modelPattern = newPrice.modelPattern.trim();
    const values = parsePriceValues(newPrice);
    if (!provider || !modelPattern) {
      setFormError('请选择 Provider 并输入模型。');
      return;
    }
    if (!values) {
      setFormError('价格必须填写完整，并且是大于或等于 0 的数字。');
      return;
    }
    setCreating(true);
    setFormError('');
    try {
      await upsertModelPrice({
        provider,
        modelPattern,
        inputPerMillion: values[0],
        cachedInputPerMillion: values[1],
        outputPerMillion: values[2],
      });
      await reloadPrices();
      setShowAdd(false);
      setNewPrice(emptyPriceDraft);
    } catch (caught) {
      setFormError(caught instanceof ApiError ? caught.message : '价格新增失败。');
    } finally {
      setCreating(false);
    }
  };

  const removePrice = async (price: ModelPriceRule) => {
    if (!window.confirm(`确定删除“${price.modelPattern} · ${price.provider}”的价格记录吗？`)) {
      return;
    }
    const key = priceRuleKey(price.provider, price.modelPattern);
    setDeleting(key);
    setError('');
    try {
      await deleteModelPrice({ provider: price.provider, modelPattern: price.modelPattern });
      await reloadPrices();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '价格删除失败。');
    } finally {
      setDeleting('');
    }
  };

  return (
    <div className="page-wrap">
      <PageHeader
        title="模型价格"
        action={
          <Button
            onClick={() => {
              setFormError('');
              setNewPrice(emptyPriceDraft);
              setShowAdd(true);
            }}
          >
            <Plus size={14} /> 新增价格
          </Button>
        }
      />

      {error ? <div className="form-error model-pricing-error">{error}</div> : null}
      {loading ? (
        <Skeleton height={320} />
      ) : (
        <section className="panel flush-panel model-pricing-panel">
          <div className="panel-heading model-pricing-heading">
            <span className="panel-note">仅展示已配置记录 · USD / 1M tokens</span>
          </div>
          <div className="table-wrap model-pricing-table">
            <table>
              <thead>
                <tr>
                  <th>Provider / 模型规则</th>
                  <th>输入</th>
                  <th>缓存输入</th>
                  <th>输出</th>
                  <th>更新时间</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {prices?.length ? (
                  prices.map((price) => {
                    const key = priceRuleKey(price.provider, price.modelPattern);
                    const initial = priceDraft(price);
                    const draft = drafts[key] ?? initial;
                    const changed = (
                      ['inputPerMillion', 'cachedInputPerMillion', 'outputPerMillion'] as const
                    ).some((field) => draft[field] !== initial[field]);
                    return (
                      <tr key={key}>
                        <td>
                          <strong>{price.modelPattern}</strong>
                          <small>{price.provider}</small>
                        </td>
                        {(
                          ['inputPerMillion', 'cachedInputPerMillion', 'outputPerMillion'] as const
                        ).map((field) => (
                          <td key={field}>
                            <input
                              className="model-price-input"
                              type="number"
                              min="0"
                              step="0.000001"
                              value={draft[field]}
                              required
                              onChange={(event) => {
                                setSaved((current) => (current === key ? '' : current));
                                setDrafts((current) => ({
                                  ...current,
                                  [key]: { ...draft, [field]: event.target.value },
                                }));
                              }}
                              aria-label={`${price.modelPattern} ${field}`}
                            />
                          </td>
                        ))}
                        <td>{fullDate.format(new Date(price.updatedAt))}</td>
                        <td>
                          <div className="model-price-row-actions">
                            <Button
                              variant="secondary"
                              loading={saving === key}
                              disabled={!changed || deleting === key}
                              onClick={() => void savePrice(price)}
                            >
                              {saved === key && !changed ? <Check size={13} /> : <Save size={13} />}
                              {saved === key && !changed ? '已保存' : '保存'}
                            </Button>
                            <Button
                              variant="ghost"
                              loading={deleting === key}
                              disabled={saving === key}
                              onClick={() => void removePrice(price)}
                            >
                              <Trash2 size={14} /> 删除
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={6} className="table-empty">
                      暂无价格记录，请点击“新增价格”单独配置
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {showAdd ? (
        <Modal
          title="新增模型价格"
          onClose={() => {
            setShowAdd(false);
            setFormError('');
          }}
        >
          <form className="modal-body" onSubmit={(event) => void createPrice(event)}>
            <Field label="Provider" hint="“全部 Provider”会作为通用兜底价格。">
              <select
                className="input"
                value={newPrice.provider}
                onChange={(event) =>
                  setNewPrice({ ...newPrice, provider: event.target.value, modelPattern: '' })
                }
              >
                <option value="*">全部 Provider</option>
                {providerOptions.map((provider) => (
                  <option value={provider} key={provider}>
                    {provider}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="模型" hint="从已同步模型中选择，也可以直接输入模型名称或前缀规则。">
              <ComboboxInput
                options={modelOptions}
                value={newPrice.modelPattern}
                onChange={(event) => setNewPrice({ ...newPrice, modelPattern: event.target.value })}
                placeholder="选择或输入模型"
                required
              />
            </Field>
            <div className="model-price-form-grid">
              {(
                [
                  ['inputPerMillion', '输入'],
                  ['cachedInputPerMillion', '缓存输入'],
                  ['outputPerMillion', '输出'],
                ] as const
              ).map(([field, label]) => (
                <Field label={label} key={field}>
                  <Input
                    type="number"
                    min="0"
                    step="0.000001"
                    value={newPrice[field]}
                    onChange={(event) => setNewPrice({ ...newPrice, [field]: event.target.value })}
                    required
                  />
                </Field>
              ))}
            </div>
            {formError ? (
              <div className="form-error" role="alert">
                {formError}
              </div>
            ) : null}
            <div className="modal-actions">
              <Button type="button" variant="secondary" onClick={() => setShowAdd(false)}>
                取消
              </Button>
              <Button type="submit" loading={creating}>
                新增记录
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
