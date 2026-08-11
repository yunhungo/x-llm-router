import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  CircleDollarSign,
  ChevronDown,
  Clock3,
  Gauge,
  KeyRound,
  RefreshCcw,
  Save,
  Timer,
  Zap,
} from 'lucide-react';
import { useParams } from 'react-router-dom';

import { api, ApiError, jsonBody } from '../api';
import { Badge, Button, PageHeader, Skeleton } from '../components/ui';
import type {
  KeyAnalyticsRange,
  KeyAnalyticsResponse,
  KeyLogMetric,
  KeyUsageLogsResponse,
  KeyUsagePoint,
  ModelPriceMatch,
  Provider,
} from '../types';
import './key-detail.css';
import { KeyPerformanceChart, type PerformanceMetric } from './key-performance-chart';
import { UsageLogDetailPanel } from './usage-log-detail';

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

interface LogDrilldown {
  label: string;
  metric: KeyLogMetric;
  threshold?: number;
  from?: string;
  to?: string;
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

function finiteMetric(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
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
  const [range, setRange] = useState<KeyAnalyticsRange>('24h');
  const [data, setData] = useState<KeyAnalyticsResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [priceDrafts, setPriceDrafts] = useState<Record<string, PriceDraft>>({});
  const [savingPrice, setSavingPrice] = useState('');
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerId, setProviderId] = useState('');
  const [savingProvider, setSavingProvider] = useState(false);
  const [expandedLogId, setExpandedLogId] = useState<string>();
  const [chartMetric, setChartMetric] = useState<PerformanceMetric>('calls');
  const [drilldown, setDrilldown] = useState<LogDrilldown>();
  const [focusedLogs, setFocusedLogs] = useState<KeyUsageLogsResponse>();
  const [logsLoading, setLogsLoading] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    setDrilldown(undefined);
    setFocusedLogs(undefined);
    setExpandedLogId(undefined);
    try {
      const [response, providerResponse] = await Promise.all([
        api<KeyAnalyticsResponse>(`/api/admin/keys/${id}/analytics?range=${range}&limit=100`),
        api<{ providers: Provider[] }>('/api/admin/providers'),
      ]);
      setData(response);
      setProviders(providerResponse.providers.filter((provider) => provider.status === 'active'));
      setProviderId(response.key.providerConnectionId ?? '');
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

  const loadDrilldown = async (next: LogDrilldown) => {
    if (!id) return;
    setLogsLoading(true);
    setError('');
    setDrilldown(next);
    setExpandedLogId(undefined);
    const params = new URLSearchParams({ range, limit: '100', metric: next.metric });
    if (next.threshold !== undefined) params.set('threshold', String(next.threshold));
    if (next.from) params.set('from', next.from);
    if (next.to) params.set('to', next.to);
    try {
      const response = await api<KeyUsageLogsResponse>(
        `/api/admin/keys/${id}/analytics/logs?${params.toString()}`,
      );
      setFocusedLogs(response);
      requestAnimationFrame(() =>
        document.getElementById('key-usage-logs')?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        }),
      );
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '调用明细查询失败。');
    } finally {
      setLogsLoading(false);
    }
  };

  const selectBucket = (point: KeyUsagePoint) => {
    void loadDrilldown({
      label: `${formatDate(point.bucket)} 时间桶`,
      metric: 'recent',
      from: point.bucket,
      to: point.bucketEnd,
    });
  };

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

  const saveProvider = async () => {
    if (!id) return;
    setSavingProvider(true);
    setError('');
    setNotice('');
    try {
      await api(`/api/admin/keys/${id}`, {
        method: 'PATCH',
        ...jsonBody({ providerConnectionId: providerId || null }),
      });
      setNotice('上游连接已更新，仅影响后续调用。');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '上游连接保存失败。');
    } finally {
      setSavingProvider(false);
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
        <div className="form-error">{error || 'API Key 不存在。'}</div>
      </div>
    );
  }

  const { key, summary } = data;
  const cacheRate = summary.inputTokens
    ? (summary.cachedInputTokens / summary.inputTokens) * 100
    : 0;
  const p50Tps = finiteMetric(summary.p50Tps, finiteMetric(summary.averageTps));
  const p10Tps = finiteMetric(summary.p10Tps, p50Tps);
  const streamingCalls = finiteMetric(
    summary.streamingCalls,
    data.logs.filter((log) => log.timeToFirstTokenMs !== null).length,
  );
  const p50TtftMs = finiteMetric(summary.p50TtftMs, finiteMetric(summary.averageTtftMs));
  const p95TtftMs = finiteMetric(summary.p95TtftMs, p50TtftMs);
  const p99TtftMs = finiteMetric(summary.p99TtftMs, p95TtftMs);
  const p50LatencyMs = finiteMetric(summary.p50LatencyMs, finiteMetric(summary.averageLatencyMs));
  const p95LatencyMs = finiteMetric(summary.p95LatencyMs, p50LatencyMs);
  const p99LatencyMs = finiteMetric(summary.p99LatencyMs, p95LatencyMs);
  const visibleLogs = focusedLogs?.logs ?? data.logs;

  return (
    <div className="page-wrap key-detail-page">
      <PageHeader
        title={key.name}
        action={
          <div className="detail-actions">
            <div className="range-switch" aria-label="统计范围">
              {(
                [
                  ['24h', '天'],
                  ['7d', '周'],
                  ['30d', '月'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  className={range === value ? 'active' : ''}
                  onClick={() => setRange(value)}
                >
                  {label}
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
          <strong>{decimal.format(p50Tps)}</strong>
          <small>
            P50 · 平均 {decimal.format(summary.averageTps)}
            <button
              type="button"
              disabled={p10Tps <= 0}
              onClick={(event) => {
                event.stopPropagation();
                void loadDrilldown({
                  label: `TPS ≤ P10 (${decimal.format(p10Tps)} token/s)`,
                  metric: 'tps',
                  threshold: p10Tps,
                });
              }}
            >
              查看 P10 慢尾
            </button>
          </small>
        </article>
        <article className="metric-card">
          <span>TTFT</span>
          <strong>{decimal.format(p50TtftMs)} ms</strong>
          <small>
            P50 · {integer.format(streamingCalls)} 次流式调用
            <span className="metric-query-links">
              <button
                type="button"
                disabled={streamingCalls === 0}
                onClick={(event) => {
                  event.stopPropagation();
                  void loadDrilldown({
                    label: `TTFT ≥ P95 (${decimal.format(p95TtftMs)} ms)`,
                    metric: 'ttft',
                    threshold: p95TtftMs,
                  });
                }}
              >
                P95
              </button>
              <button
                type="button"
                disabled={streamingCalls === 0}
                onClick={(event) => {
                  event.stopPropagation();
                  void loadDrilldown({
                    label: `TTFT ≥ P99 (${decimal.format(p99TtftMs)} ms)`,
                    metric: 'ttft',
                    threshold: p99TtftMs,
                  });
                }}
              >
                P99
              </button>
            </span>
          </small>
        </article>
        <article className="metric-card">
          <span>端到端延迟</span>
          <strong>{decimal.format(p50LatencyMs)} ms</strong>
          <small>
            P50 · 平均 {decimal.format(summary.averageLatencyMs)} ms
            <span className="metric-query-links">
              <button
                type="button"
                disabled={summary.calls === 0}
                onClick={(event) => {
                  event.stopPropagation();
                  void loadDrilldown({
                    label: `延迟 ≥ P95 (${decimal.format(p95LatencyMs)} ms)`,
                    metric: 'latency',
                    threshold: p95LatencyMs,
                  });
                }}
              >
                P95
              </button>
              <button
                type="button"
                disabled={summary.calls === 0}
                onClick={(event) => {
                  event.stopPropagation();
                  void loadDrilldown({
                    label: `延迟 ≥ P99 (${decimal.format(p99LatencyMs)} ms)`,
                    metric: 'latency',
                    threshold: p99LatencyMs,
                  });
                }}
              >
                P99
              </button>
            </span>
          </small>
        </article>
        <article className="metric-card">
          <span>峰值 RPM</span>
          <strong>{integer.format(summary.peakRpm)}</strong>
          <small>限额 {integer.format(key.rpmLimit)}</small>
        </article>
      </section>

      <KeyPerformanceChart
        points={data.series}
        range={range}
        metric={chartMetric}
        onMetricChange={setChartMetric}
        onBucketSelect={selectBucket}
      />

      <div className="key-analytics-grid detail-section">
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
            <h2>配置</h2>
          </div>
          <div className="key-provider-editor">
            <label htmlFor="key-provider">上游连接</label>
            <div>
              <select
                id="key-provider"
                className="input"
                value={providerId}
                onChange={(event) => setProviderId(event.target.value)}
              >
                <option value="">自动路由</option>
                {providers.map((provider) => (
                  <option value={provider.id} key={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
              <Button
                variant="secondary"
                loading={savingProvider}
                disabled={providerId === (key.providerConnectionId ?? '')}
                onClick={() => void saveProvider()}
              >
                保存
              </Button>
            </div>
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

      <section className="panel flush-panel detail-section" id="key-usage-logs">
        <div className="panel-heading usage-log-heading">
          <div>
            <h2>调用记录</h2>
            <span className="panel-note">
              {drilldown ? `${drilldown.label} · ${focusedLogs?.total ?? 0} 条` : '最近 100 条'}
            </span>
          </div>
          {drilldown ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setDrilldown(undefined);
                setFocusedLogs(undefined);
                setExpandedLogId(undefined);
              }}
            >
              清除筛选
            </Button>
          ) : null}
        </div>
        {logsLoading ? <div className="log-query-progress">正在查询对应请求…</div> : null}
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
                <th />
              </tr>
            </thead>
            <tbody>
              {visibleLogs.length ? (
                visibleLogs.map((log) => (
                  <Fragment key={log.id}>
                    <tr
                      className="usage-log-row"
                      aria-expanded={expandedLogId === log.id}
                      onClick={() =>
                        setExpandedLogId((current) => (current === log.id ? undefined : log.id))
                      }
                    >
                      <td>
                        <Badge tone={log.success ? 'success' : 'danger'}>{log.statusCode}</Badge>
                      </td>
                      <td>
                        <code>{endpointLabel(log.endpoint)}</code>
                        <small>{log.providerName ?? '—'}</small>
                      </td>
                      <td>
                        <code>{log.model}</code>
                        {log.requestedModel !== log.model ? (
                          <small>请求 {log.requestedModel}</small>
                        ) : log.errorCode ? (
                          <small>{log.errorCode}</small>
                        ) : null}
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
                      <td>
                        <button
                          className="usage-expand-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setExpandedLogId((current) =>
                              current === log.id ? undefined : log.id,
                            );
                          }}
                          aria-label={expandedLogId === log.id ? '收起调用明细' : '展开调用明细'}
                        >
                          <ChevronDown size={15} />
                        </button>
                      </td>
                    </tr>
                    {expandedLogId === log.id ? (
                      <tr className="usage-detail-row">
                        <td colSpan={9}>
                          <UsageLogDetailPanel usageLogId={log.id} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))
              ) : (
                <tr>
                  <td colSpan={9} className="table-empty">
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
