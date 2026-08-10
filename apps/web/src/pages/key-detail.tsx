import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  CircleDollarSign,
  Clock3,
  Gauge,
  KeyRound,
  RefreshCcw,
  Save,
  Timer,
  Zap,
} from 'lucide-react';
import { Link, useParams } from 'react-router-dom';

import { api, ApiError, jsonBody } from '../api';
import { Badge, Button, PageHeader, Skeleton } from '../components/ui';
import type { KeyAnalyticsRange, KeyAnalyticsResponse, ModelPriceMatch } from '../types';
import './key-detail.css';

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 4,
  maximumFractionDigits: 8,
});
const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

interface PriceDraft {
  inputPerMillion: string;
  cachedInputPerMillion: string;
  outputPerMillion: string;
}

function priceDraft(price: ModelPriceMatch): PriceDraft {
  return {
    inputPerMillion: price.inputPerMillion?.toString() ?? '',
    cachedInputPerMillion: price.cachedInputPerMillion?.toString() ?? '',
    outputPerMillion: price.outputPerMillion?.toString() ?? '',
  };
}

function successRate(calls: number, successfulCalls: number) {
  return calls ? (successfulCalls / calls) * 100 : 0;
}

function formatDate(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function endpointLabel(endpoint: string) {
  return endpoint === 'responses' ? '/responses' : '/chat/completions';
}

export function KeyDetailPage() {
  const { id } = useParams();
  const [range, setRange] = useState<KeyAnalyticsRange>('7d');
  const [data, setData] = useState<KeyAnalyticsResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [priceDrafts, setPriceDrafts] = useState<Record<string, PriceDraft>>({});
  const [savingPrice, setSavingPrice] = useState('');

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const response = await api<KeyAnalyticsResponse>(
        `/api/admin/keys/${id}/analytics?range=${range}&limit=100`,
      );
      setData(response);
      setPriceDrafts(
        Object.fromEntries(
          response.prices.map((price) => [`${price.provider}:${price.model}`, priceDraft(price)]),
        ),
      );
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '调用数据加载失败。');
    } finally {
      setLoading(false);
    }
  }, [id, range]);

  useEffect(() => void load(), [load]);

  const maxCalls = useMemo(
    () => Math.max(1, ...(data?.series.map((point) => point.calls) ?? [1])),
    [data],
  );

  const savePrice = async (price: ModelPriceMatch) => {
    const key = `${price.provider}:${price.model}`;
    const draft = priceDrafts[key];
    if (!draft) return;
    const values = [draft.inputPerMillion, draft.cachedInputPerMillion, draft.outputPerMillion].map(
      Number,
    );
    if (values.some((value) => !Number.isFinite(value) || value < 0)) {
      setError('价格必须是大于或等于 0 的数字。');
      return;
    }
    setSavingPrice(key);
    setError('');
    setNotice('');
    try {
      await api('/api/admin/settings/model-prices', {
        method: 'PUT',
        ...jsonBody({
          provider: price.provider,
          modelPattern: price.model,
          inputPerMillion: values[0],
          cachedInputPerMillion: values[1],
          outputPerMillion: values[2],
        }),
      });
      setNotice(`已保存 ${price.provider} / ${price.model}，仅影响后续调用。`);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '价格保存失败。');
    } finally {
      setSavingPrice('');
    }
  };

  if (!data && loading) {
    return (
      <div className="page-wrap">
        <Skeleton height={720} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="page-wrap">
        <Link to="/keys" className="back-link">
          <ArrowLeft size={14} /> API Keys
        </Link>
        <div className="form-error">{error || 'API Key 不存在。'}</div>
      </div>
    );
  }

  const { key, summary } = data;
  const cacheRate = summary.inputTokens
    ? (summary.cachedInputTokens / summary.inputTokens) * 100
    : 0;

  return (
    <div className="page-wrap key-detail-page">
      <Link to="/keys" className="back-link">
        <ArrowLeft size={14} /> API Keys
      </Link>
      <PageHeader
        title={key.name}
        action={
          <div className="detail-actions">
            <div className="range-switch" aria-label="统计范围">
              {(['24h', '7d', '30d'] as const).map((value) => (
                <button
                  key={value}
                  className={range === value ? 'active' : ''}
                  onClick={() => setRange(value)}
                >
                  {value}
                </button>
              ))}
            </div>
            <Button variant="secondary" loading={loading} onClick={() => void load()}>
              <RefreshCcw size={14} /> 刷新
            </Button>
          </div>
        }
      />

      <section className="key-meta-strip">
        <span>
          <KeyRound size={13} /> <code>{key.keyPrefix}</code>
        </span>
        <span>{key.providerName ?? '自动路由'}</span>
        <span>{key.rpmLimit.toLocaleString()} RPM</span>
        <span>{key.langfuse.enabled ? 'Langfuse On' : 'Langfuse Off'}</span>
        <Badge tone={key.status === 'active' ? 'success' : 'danger'}>{key.status}</Badge>
      </section>

      {error ? <div className="form-error detail-message">{error}</div> : null}
      {notice ? <div className="notice success detail-message">{notice}</div> : null}

      <section className="stat-grid">
        <article className="stat-card">
          <span>调用</span>
          <div className="stat-icon">
            <Zap size={14} />
          </div>
          <strong>{integer.format(summary.calls)}</strong>
          <small>{integer.format(summary.failedCalls)} 次失败</small>
        </article>
        <article className="stat-card">
          <span>Token</span>
          <div className="stat-icon">
            <Gauge size={14} />
          </div>
          <strong>{integer.format(summary.totalTokens)}</strong>
          <small>{integer.format(summary.cachedInputTokens)} cached</small>
        </article>
        <article className="stat-card">
          <span>成本</span>
          <div className="stat-icon">
            <CircleDollarSign size={14} />
          </div>
          <strong>{money.format(summary.costUsd)}</strong>
          <small>平均 {money.format(summary.averageCostUsd)} / 次</small>
        </article>
        <article className="stat-card">
          <span>成功率</span>
          <div className="stat-icon">
            <Timer size={14} />
          </div>
          <strong>{decimal.format(successRate(summary.calls, summary.successfulCalls))}%</strong>
          <small>{integer.format(summary.successfulCalls)} 次成功</small>
        </article>
      </section>

      <section className="key-performance-grid">
        <article className="metric-card">
          <span>缓存命中</span>
          <strong>{decimal.format(cacheRate)}%</strong>
          <small>
            {integer.format(summary.cachedInputTokens)} / {integer.format(summary.inputTokens)}{' '}
            input
          </small>
        </article>
        <article className="metric-card">
          <span>TPS</span>
          <strong>{decimal.format(summary.averageTps)}</strong>
          <small>P95 {decimal.format(summary.p95Tps)} token/s</small>
        </article>
        <article className="metric-card">
          <span>TTFT</span>
          <strong>{decimal.format(summary.averageTtftMs)} ms</strong>
          <small>P95 {decimal.format(summary.p95TtftMs)} ms</small>
        </article>
        <article className="metric-card">
          <span>端到端延迟</span>
          <strong>{decimal.format(summary.averageLatencyMs)} ms</strong>
          <small>P95 {decimal.format(summary.p95LatencyMs)} ms</small>
        </article>
        <article className="metric-card">
          <span>峰值 RPM</span>
          <strong>{integer.format(summary.peakRpm)}</strong>
          <small>限额 {integer.format(key.rpmLimit)}</small>
        </article>
      </section>

      <div className="key-analytics-grid">
        <section className="panel key-trend-panel">
          <div className="panel-heading">
            <h2>调用趋势</h2>
            <span className="panel-note">Calls / bucket</span>
          </div>
          {data.series.length ? (
            <div className="trend-bars" role="img" aria-label="调用趋势图">
              {data.series.map((point) => (
                <div className="trend-column" key={point.bucket}>
                  <div
                    className="trend-bar"
                    style={{ height: `${Math.max(4, (point.calls / maxCalls) * 100)}%` }}
                    title={`${formatDate(point.bucket)} · ${point.calls} calls · ${integer.format(point.tokens)} tokens`}
                  />
                  <span>
                    {new Date(point.bucket).toLocaleDateString('zh-CN', {
                      month: '2-digit',
                      day: '2-digit',
                    })}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="analytics-empty">该时段没有调用。</div>
          )}
        </section>

        <section className="panel distribution-panel">
          <div className="panel-heading">
            <h2>端点</h2>
          </div>
          <div className="distribution-list">
            {data.endpoints.length ? (
              data.endpoints.map((endpoint) => (
                <div key={endpoint.endpoint}>
                  <code>{endpointLabel(endpoint.endpoint)}</code>
                  <span>{endpoint.calls} calls</span>
                  <small>
                    {decimal.format(successRate(endpoint.calls, endpoint.successfulCalls))}% 成功
                  </small>
                </div>
              ))
            ) : (
              <div className="analytics-empty">暂无数据</div>
            )}
          </div>
        </section>
      </div>

      <section className="panel flush-panel detail-section">
        <div className="panel-heading">
          <h2>模型</h2>
          <span className="panel-note">按实际调用聚合</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Provider / 模型</th>
                <th>调用</th>
                <th>Token</th>
                <th>缓存</th>
                <th>TPS</th>
                <th>延迟</th>
                <th>成本</th>
              </tr>
            </thead>
            <tbody>
              {data.models.length ? (
                data.models.map((model) => (
                  <tr key={`${model.provider}:${model.model}`}>
                    <td>
                      <strong>{model.model}</strong>
                      <small>{model.provider}</small>
                    </td>
                    <td>
                      {model.calls.toLocaleString()}
                      <small>
                        {decimal.format(successRate(model.calls, model.successfulCalls))}% success
                      </small>
                    </td>
                    <td>
                      {integer.format(model.totalTokens)}
                      <small>
                        {integer.format(model.inputTokens)} in ·{' '}
                        {integer.format(model.outputTokens)} out
                      </small>
                    </td>
                    <td>{integer.format(model.cachedInputTokens)}</td>
                    <td>{decimal.format(model.averageTps)}</td>
                    <td>{decimal.format(model.averageLatencyMs)} ms</td>
                    <td>{money.format(model.costUsd)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="table-empty">
                    暂无模型调用。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="breakdown-grid detail-section">
        <section className="panel">
          <div className="panel-heading">
            <h2>错误</h2>
          </div>
          <div className="distribution-list error-list">
            {data.errors.length ? (
              data.errors.map((item) => (
                <div key={item.code}>
                  <code>{item.code}</code>
                  <strong>{item.calls}</strong>
                </div>
              ))
            ) : (
              <div className="analytics-empty">该时段没有错误。</div>
            )}
          </div>
        </section>
        <section className="panel key-config-summary">
          <div className="panel-heading">
            <h2>限额</h2>
          </div>
          <dl>
            <div>
              <dt>预算</dt>
              <dd>{key.budgetUsd === null ? 'Unlimited' : money.format(key.budgetUsd)}</dd>
            </div>
            <div>
              <dt>累计使用</dt>
              <dd>{money.format(key.spendUsd)}</dd>
            </div>
            <div>
              <dt>最近调用</dt>
              <dd>{key.lastUsedAt ? formatDate(key.lastUsedAt) : 'Never'}</dd>
            </div>
          </dl>
        </section>
      </div>

      <section className="panel flush-panel detail-section">
        <div className="panel-heading pricing-heading">
          <div>
            <h2>价格</h2>
            <span className="panel-note">USD / 1M tokens，新价格仅影响后续调用</span>
          </div>
        </div>
        <div className="table-wrap pricing-table">
          <table>
            <thead>
              <tr>
                <th>Provider / 模型</th>
                <th>输入</th>
                <th>缓存输入</th>
                <th>输出</th>
                <th>当前规则</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.prices.length ? (
                data.prices.map((price) => {
                  const draftKey = `${price.provider}:${price.model}`;
                  const draft = priceDrafts[draftKey] ?? priceDraft(price);
                  return (
                    <tr key={draftKey}>
                      <td>
                        <strong>{price.model}</strong>
                        <small>{price.provider}</small>
                      </td>
                      {(
                        ['inputPerMillion', 'cachedInputPerMillion', 'outputPerMillion'] as const
                      ).map((field) => (
                        <td key={field}>
                          <input
                            className="price-input"
                            type="number"
                            min="0"
                            step="0.000001"
                            value={draft[field]}
                            onChange={(event) =>
                              setPriceDrafts((current) => ({
                                ...current,
                                [draftKey]: { ...draft, [field]: event.target.value },
                              }))
                            }
                            aria-label={`${price.model} ${field}`}
                          />
                        </td>
                      ))}
                      <td>
                        {price.matchedPattern ? (
                          <>
                            <code>{price.matchedPattern}</code>
                            <small>{price.matchedProvider}</small>
                          </>
                        ) : (
                          '未配置'
                        )}
                      </td>
                      <td>
                        <Button
                          variant="secondary"
                          loading={savingPrice === draftKey}
                          onClick={() => void savePrice(price)}
                        >
                          <Save size={13} /> 保存
                        </Button>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} className="table-empty">
                    有模型调用后可配置价格。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel flush-panel detail-section">
        <div className="panel-heading">
          <h2>调用记录</h2>
          <span className="panel-note">最近 100 条</span>
        </div>
        <div className="table-wrap usage-table key-detail-table">
          <table>
            <thead>
              <tr>
                <th>状态</th>
                <th>请求</th>
                <th>模型</th>
                <th>Token</th>
                <th>TPS / TTFT</th>
                <th>延迟</th>
                <th>成本</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {data.logs.length ? (
                data.logs.map((log) => (
                  <tr key={log.id}>
                    <td>
                      <Badge tone={log.success ? 'success' : 'danger'}>{log.statusCode}</Badge>
                    </td>
                    <td>
                      <code>{endpointLabel(log.endpoint)}</code>
                      <small>{log.providerName ?? '—'}</small>
                    </td>
                    <td>
                      <code>{log.model}</code>
                      {log.errorCode ? <small>{log.errorCode}</small> : null}
                    </td>
                    <td>
                      {integer.format(log.totalTokens)}
                      <small>
                        {integer.format(log.inputTokens)} in ·{' '}
                        {integer.format(log.cachedInputTokens)} cached ·{' '}
                        {integer.format(log.outputTokens)} out
                      </small>
                    </td>
                    <td>
                      {log.tps === null ? '—' : decimal.format(log.tps)}
                      <small>
                        {log.timeToFirstTokenMs === null
                          ? 'TTFT —'
                          : `TTFT ${log.timeToFirstTokenMs} ms`}
                      </small>
                    </td>
                    <td>{integer.format(log.latencyMs)} ms</td>
                    <td>{money.format(log.costUsd)}</td>
                    <td>{formatDate(log.createdAt)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={8} className="table-empty">
                    该时段没有调用记录。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
