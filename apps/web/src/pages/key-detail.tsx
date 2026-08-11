import { Fragment, useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  BarChart3,
  Check,
  ChevronDown,
  CircleDollarSign,
  Gauge,
  Info,
  KeyRound,
  List,
  RefreshCcw,
  Save,
  Search,
  Settings2,
  Timer,
  X,
  Zap,
} from 'lucide-react';
import { useParams } from 'react-router-dom';

import { api, ApiError, jsonBody } from '../api';
import {
  emptyLangfuse,
  LangfuseFields,
  langfuseDraft,
  langfusePayload,
  type LangfuseDraft,
} from '../components/langfuse-fields';
import { Badge, Button, Field, Input, PageHeader, Skeleton } from '../components/ui';
import type {
  KeyAnalyticsRange,
  KeyAnalyticsResponse,
  KeyLogMetric,
  KeyUsageLog,
  KeyUsageLogsResponse,
  KeyUsagePoint,
  ModelPriceMatch,
  Provider,
  VirtualKey,
} from '../types';
import './key-detail.css';
import {
  KeyPerformanceChart,
  type ChartGrouping,
  type PerformanceMetric,
} from './key-performance-chart';
import { groupKeyErrors } from './key-error-summary';
import { UsageLogDetailPanel } from './usage-log-detail';

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 4,
  maximumFractionDigits: 8,
});
const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

type DetailTab = 'overview' | 'charts' | 'logs' | 'settings';
type LogStatusFilter = 'all' | 'success' | 'failed';

interface PriceDraft {
  inputPerMillion: string;
  cachedInputPerMillion: string;
  outputPerMillion: string;
}

interface GeneralDraft {
  name: string;
  rpmLimit: string;
  budgetUsd: string;
  expiresAt: string;
  providerConnectionId: string;
}

interface LogDrilldown {
  label: string;
  metric: KeyLogMetric;
  threshold?: number;
  from?: string;
  to?: string;
}

const detailTabs: Array<{
  value: DetailTab;
  label: string;
  icon: typeof Info;
}> = [
  { value: 'overview', label: '基本信息', icon: Info },
  { value: 'charts', label: '图表', icon: BarChart3 },
  { value: 'logs', label: '调用记录', icon: List },
  { value: 'settings', label: '设置', icon: Settings2 },
];

const rangeLabels: Record<KeyAnalyticsRange, string> = {
  '24h': '近 24 小时',
  '7d': '近 7 天',
  '30d': '近 30 天',
};

function priceDraft(price: ModelPriceMatch): PriceDraft {
  return {
    inputPerMillion: price.inputPerMillion?.toString() ?? '',
    cachedInputPerMillion: price.cachedInputPerMillion?.toString() ?? '',
    outputPerMillion: price.outputPerMillion?.toString() ?? '',
  };
}

function datetimeLocalValue(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function generalDraft(key: VirtualKey): GeneralDraft {
  return {
    name: key.name,
    rpmLimit: String(key.rpmLimit),
    budgetUsd: key.budgetUsd?.toString() ?? '',
    expiresAt: datetimeLocalValue(key.expiresAt),
    providerConnectionId: key.providerConnectionId ?? '',
  };
}

function sameGeneralDraft(left: GeneralDraft, right: GeneralDraft) {
  return (
    left.name === right.name &&
    left.rpmLimit === right.rpmLimit &&
    left.budgetUsd === right.budgetUsd &&
    left.expiresAt === right.expiresAt &&
    left.providerConnectionId === right.providerConnectionId
  );
}

function sameLangfuseDraft(left: LangfuseDraft, right: LangfuseDraft) {
  return JSON.stringify(langfusePayload(left)) === JSON.stringify(langfusePayload(right));
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

function formatFullDate(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function endpointLabel(endpoint: string) {
  return endpoint === 'responses' ? '/responses' : '/chat/completions';
}

function RangeSwitch({
  value,
  onChange,
}: {
  value: KeyAnalyticsRange;
  onChange: (range: KeyAnalyticsRange) => void;
}) {
  return (
    <div className="range-switch" aria-label="统计范围">
      {(
        [
          ['24h', '天'],
          ['7d', '周'],
          ['30d', '月'],
        ] as const
      ).map(([range, label]) => (
        <button
          type="button"
          key={range}
          className={value === range ? 'active' : ''}
          onClick={() => onChange(range)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function KeyDetailPage() {
  const { id } = useParams();
  const [activeTab, setActiveTab] = useState<DetailTab>('overview');
  const [range, setRange] = useState<KeyAnalyticsRange>('24h');
  const [data, setData] = useState<KeyAnalyticsResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [priceDrafts, setPriceDrafts] = useState<Record<string, PriceDraft>>({});
  const [savingPrice, setSavingPrice] = useState('');
  const [providers, setProviders] = useState<Provider[]>([]);
  const [generalSettings, setGeneralSettings] = useState<GeneralDraft>();
  const [savingGeneral, setSavingGeneral] = useState(false);
  const [langfuseSettings, setLangfuseSettings] = useState<LangfuseDraft>(emptyLangfuse);
  const [savingLangfuse, setSavingLangfuse] = useState(false);
  const [savedSettings, setSavedSettings] = useState<'general' | 'langfuse'>();
  const [expandedLogId, setExpandedLogId] = useState<string>();
  const [expandedErrorCode, setExpandedErrorCode] = useState<string>();
  const [expandedOverviewLogId, setExpandedOverviewLogId] = useState<string>();
  const [chartMetric, setChartMetric] = useState<PerformanceMetric>('calls');
  const [chartGrouping, setChartGrouping] = useState<ChartGrouping>('total');
  const [drilldown, setDrilldown] = useState<LogDrilldown>();
  const [focusedLogs, setFocusedLogs] = useState<KeyUsageLogsResponse>();
  const [logsLoading, setLogsLoading] = useState(false);
  const [logSearch, setLogSearch] = useState('');
  const [logStatus, setLogStatus] = useState<LogStatusFilter>('all');
  const [logModel, setLogModel] = useState('all');
  const [logEndpoint, setLogEndpoint] = useState('all');

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    setDrilldown(undefined);
    setFocusedLogs(undefined);
    setExpandedLogId(undefined);
    setExpandedErrorCode(undefined);
    setExpandedOverviewLogId(undefined);
    try {
      const [response, providerResponse] = await Promise.all([
        api<KeyAnalyticsResponse>(`/api/admin/keys/${id}/analytics?range=${range}&limit=100`),
        api<{ providers: Provider[] }>('/api/admin/providers'),
      ]);
      setData(response);
      setProviders(providerResponse.providers.filter((provider) => provider.status === 'active'));
      setGeneralSettings(generalDraft(response.key));
      setLangfuseSettings(langfuseDraft(response.key.langfuse));
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
    setActiveTab('logs');
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

  const clearDrilldown = () => {
    setDrilldown(undefined);
    setFocusedLogs(undefined);
    setExpandedLogId(undefined);
  };

  const selectBucket = (point: KeyUsagePoint) => {
    void loadDrilldown({
      label: formatDate(point.bucket),
      metric: 'recent',
      from: point.bucket,
      to: point.bucketEnd,
    });
  };

  const savePrice = async (price: ModelPriceMatch) => {
    const key = `${price.provider}:${price.model}`;
    const draft = priceDrafts[key];
    if (!draft) return;
    const rawValues = [draft.inputPerMillion, draft.cachedInputPerMillion, draft.outputPerMillion];
    if (rawValues.some((value) => value.trim() === '')) {
      setError('请填写完整的输入、缓存输入和输出价格。');
      return;
    }
    const values = rawValues.map(Number);
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
      setNotice(`已保存 ${price.model} 的价格。`);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '价格保存失败。');
    } finally {
      setSavingPrice('');
    }
  };

  const saveGeneral = async (event: FormEvent) => {
    event.preventDefault();
    if (!id || !generalSettings) return;
    const rpmLimit = Number(generalSettings.rpmLimit);
    const budgetUsd = generalSettings.budgetUsd === '' ? null : Number(generalSettings.budgetUsd);
    if (!generalSettings.name.trim()) {
      setError('名称不能为空。');
      return;
    }
    if (!Number.isInteger(rpmLimit) || rpmLimit < 1 || rpmLimit > 100_000) {
      setError('RPM 必须是 1 到 100000 之间的整数。');
      return;
    }
    if (budgetUsd !== null && (!Number.isFinite(budgetUsd) || budgetUsd < 0)) {
      setError('预算必须是大于或等于 0 的数字。');
      return;
    }
    setSavingGeneral(true);
    setError('');
    setNotice('');
    try {
      await api(`/api/admin/keys/${id}`, {
        method: 'PATCH',
        ...jsonBody({
          name: generalSettings.name.trim(),
          rpmLimit,
          budgetUsd,
          expiresAt: generalSettings.expiresAt
            ? new Date(generalSettings.expiresAt).toISOString()
            : null,
          providerConnectionId: generalSettings.providerConnectionId || null,
        }),
      });
      setNotice('基本设置已保存。');
      setSavedSettings('general');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '基本设置保存失败。');
    } finally {
      setSavingGeneral(false);
    }
  };

  const saveLangfuse = async (event: FormEvent) => {
    event.preventDefault();
    if (!id) return;
    setSavingLangfuse(true);
    setError('');
    setNotice('');
    try {
      await api(`/api/admin/keys/${id}/langfuse`, {
        method: 'PUT',
        ...jsonBody({
          ...langfusePayload(langfuseSettings),
          secretKey: langfuseSettings.secretKey || undefined,
        }),
      });
      setNotice('Langfuse 设置已保存。');
      setSavedSettings('langfuse');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Langfuse 保存失败。');
    } finally {
      setSavingLangfuse(false);
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
  const normalizedLogSearch = logSearch.trim().toLowerCase();
  const filteredLogs = visibleLogs.filter((log) => {
    if (logStatus === 'success' && !log.success) return false;
    if (logStatus === 'failed' && log.success) return false;
    if (logModel !== 'all' && log.model !== logModel) return false;
    if (logEndpoint !== 'all' && log.endpoint !== logEndpoint) return false;
    if (!normalizedLogSearch) return true;
    return [
      log.requestId,
      log.model,
      log.requestedModel,
      log.providerName,
      log.errorCode,
      endpointLabel(log.endpoint),
      String(log.statusCode),
    ].some((value) => value?.toLowerCase().includes(normalizedLogSearch));
  });
  const hasLocalLogFilters =
    Boolean(logSearch) || logStatus !== 'all' || logModel !== 'all' || logEndpoint !== 'all';
  const logModels = [...new Set(data.models.map((model) => model.model))];
  const resetLocalLogFilters = () => {
    setLogSearch('');
    setLogStatus('all');
    setLogModel('all');
    setLogEndpoint('all');
  };
  const errorGroups = groupKeyErrors(data.errors, data.logs);
  const initialGeneral = generalDraft(key);
  const currentGeneral = generalSettings ?? generalDraft(key);
  const generalChanged = !sameGeneralDraft(currentGeneral, initialGeneral);
  const initialLangfuse = langfuseDraft(key.langfuse);
  const langfuseChanged = !sameLangfuseDraft(langfuseSettings, initialLangfuse);
  const updateGeneralSettings = (next: GeneralDraft) => {
    setGeneralSettings(next);
    setNotice('');
    setSavedSettings((current) => (current === 'general' ? undefined : current));
  };
  const updateLangfuseSettings = (next: LangfuseDraft) => {
    setLangfuseSettings(next);
    setNotice('');
    setSavedSettings((current) => (current === 'langfuse' ? undefined : current));
  };

  return (
    <div className="page-wrap key-detail-page">
      <PageHeader
        title={key.name}
        action={
          <div className="detail-actions">
            <code className="key-header-prefix">
              <KeyRound size={13} /> {key.keyPrefix}
            </code>
            <Badge tone={key.status === 'active' ? 'success' : 'danger'}>
              {key.status === 'active' ? '启用' : '已撤销'}
            </Badge>
            <Button variant="secondary" loading={loading} onClick={() => void load()}>
              <RefreshCcw size={14} /> 刷新
            </Button>
          </div>
        }
      />

      <nav className="key-detail-tabs" aria-label="API Key 详情">
        {detailTabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              type="button"
              key={tab.value}
              id={`key-tab-${tab.value}`}
              className={activeTab === tab.value ? 'active' : ''}
              aria-selected={activeTab === tab.value}
              aria-controls={`key-panel-${tab.value}`}
              onClick={() => {
                if (activeTab !== tab.value) setNotice('');
                setActiveTab(tab.value);
              }}
            >
              <Icon size={15} />
              {tab.label}
            </button>
          );
        })}
      </nav>

      {error ? <div className="form-error detail-message">{error}</div> : null}
      {notice ? <div className="notice success detail-message">{notice}</div> : null}

      {activeTab === 'overview' ? (
        <div
          id="key-panel-overview"
          className="key-tab-panel"
          role="tabpanel"
          aria-labelledby="key-tab-overview"
        >
          <section className="panel key-facts-panel">
            <div className="panel-heading compact-panel-heading">
              <h2>Key 信息</h2>
            </div>
            <dl className="key-facts-grid">
              <div>
                <dt>创建时间</dt>
                <dd>{formatFullDate(key.createdAt)}</dd>
              </div>
              <div>
                <dt>最近调用</dt>
                <dd>{key.lastUsedAt ? formatFullDate(key.lastUsedAt) : '—'}</dd>
              </div>
              <div>
                <dt>到期时间</dt>
                <dd>{key.expiresAt ? formatFullDate(key.expiresAt) : '永不过期'}</dd>
              </div>
              <div>
                <dt>上游</dt>
                <dd>{key.providerName ?? '自动路由'}</dd>
              </div>
              <div>
                <dt>RPM</dt>
                <dd>{integer.format(key.rpmLimit)}</dd>
              </div>
              <div>
                <dt>预算</dt>
                <dd>{key.budgetUsd === null ? '无限制' : money.format(key.budgetUsd)}</dd>
              </div>
              <div>
                <dt>累计使用</dt>
                <dd>{money.format(key.spendUsd)}</dd>
              </div>
            </dl>
          </section>

          <div className="overview-section-heading">
            <h2>使用概览</h2>
            <span>{rangeLabels[range]}</span>
          </div>
          <section className="stat-grid overview-stat-grid">
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
              <strong>
                {decimal.format(successRate(summary.calls, summary.successfulCalls))}%
              </strong>
              <small>{integer.format(summary.successfulCalls)} 次成功</small>
            </article>
          </section>

          <section className="panel overview-errors-panel">
            <div className="panel-heading compact-panel-heading overview-errors-heading">
              <h2>错误</h2>
              <span>{integer.format(summary.failedCalls)} 次</span>
            </div>
            {errorGroups.length ? (
              <div className="overview-error-groups">
                {errorGroups.map((group, index) => {
                  const groupExpanded = expandedErrorCode === group.code;
                  const groupId = `key-error-group-${index}`;
                  return (
                    <div className="overview-error-group" key={group.code}>
                      <button
                        type="button"
                        className="overview-error-summary"
                        aria-expanded={groupExpanded}
                        aria-controls={groupId}
                        onClick={() => {
                          setExpandedErrorCode(groupExpanded ? undefined : group.code);
                          setExpandedOverviewLogId(undefined);
                        }}
                      >
                        <code>{group.code}</code>
                        <strong>{integer.format(group.calls)} 次</strong>
                        <ChevronDown size={15} />
                      </button>
                      {groupExpanded ? (
                        <div className="overview-error-calls" id={groupId}>
                          {group.logs.length ? (
                            group.logs.map((log) => {
                              const logExpanded = expandedOverviewLogId === log.id;
                              const errorLabel = log.errorCode ?? `HTTP ${log.statusCode}`;
                              return (
                                <Fragment key={log.id}>
                                  <button
                                    type="button"
                                    className="overview-error-call"
                                    aria-expanded={logExpanded}
                                    onClick={() =>
                                      setExpandedOverviewLogId((current) =>
                                        current === log.id ? undefined : log.id,
                                      )
                                    }
                                  >
                                    <span className="overview-error-call-primary">
                                      <Badge tone="danger">{log.statusCode}</Badge>
                                      <code>{errorLabel}</code>
                                    </span>
                                    <span className="overview-error-call-route">
                                      <code>{endpointLabel(log.endpoint)}</code>
                                      <span>{log.model}</span>
                                    </span>
                                    <span className="overview-error-call-meta">
                                      <time dateTime={log.createdAt}>
                                        {formatDate(log.createdAt)}
                                      </time>
                                      <code title={log.requestId}>
                                        {log.requestId.slice(0, 14)}…
                                      </code>
                                    </span>
                                    <ChevronDown size={15} />
                                  </button>
                                  {logExpanded ? (
                                    <div className="overview-error-detail">
                                      <UsageLogDetailPanel usageLogId={log.id} initialTab="error" />
                                    </div>
                                  ) : null}
                                </Fragment>
                              );
                            })
                          ) : (
                            <div className="overview-error-empty">最近调用中无对应记录</div>
                          )}
                          {group.hiddenCalls > 0 ? (
                            <button
                              type="button"
                              className="overview-error-more"
                              onClick={() => {
                                setLogSearch(group.code);
                                setLogStatus('failed');
                                setLogModel('all');
                                setLogEndpoint('all');
                                void loadDrilldown({
                                  label: `错误 ${group.code}`,
                                  metric: 'errors',
                                });
                              }}
                            >
                              查看其余 {integer.format(group.hiddenCalls)} 条
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="analytics-empty">无错误</div>
            )}
          </section>
        </div>
      ) : null}

      {activeTab === 'charts' ? (
        <div
          id="key-panel-charts"
          className="key-tab-panel"
          role="tabpanel"
          aria-labelledby="key-tab-charts"
        >
          <div className="tab-toolbar range-toolbar">
            <span>{rangeLabels[range]}</span>
            <RangeSwitch value={range} onChange={setRange} />
          </div>

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
              <strong>
                {decimal.format(successRate(summary.calls, summary.successfulCalls))}%
              </strong>
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
                  onClick={() =>
                    void loadDrilldown({
                      label: `TPS ≤ P10 (${decimal.format(p10Tps)} token/s)`,
                      metric: 'tps',
                      threshold: p10Tps,
                    })
                  }
                >
                  查看慢尾
                </button>
              </small>
            </article>
            <article className="metric-card">
              <span>TTFT</span>
              <strong>{decimal.format(p50TtftMs)} ms</strong>
              <small>
                P50 · {integer.format(streamingCalls)} 次流式
                <span className="metric-query-links">
                  <button
                    type="button"
                    disabled={streamingCalls === 0}
                    onClick={() =>
                      void loadDrilldown({
                        label: `TTFT ≥ P95 (${decimal.format(p95TtftMs)} ms)`,
                        metric: 'ttft',
                        threshold: p95TtftMs,
                      })
                    }
                  >
                    P95
                  </button>
                  <button
                    type="button"
                    disabled={streamingCalls === 0}
                    onClick={() =>
                      void loadDrilldown({
                        label: `TTFT ≥ P99 (${decimal.format(p99TtftMs)} ms)`,
                        metric: 'ttft',
                        threshold: p99TtftMs,
                      })
                    }
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
                    onClick={() =>
                      void loadDrilldown({
                        label: `延迟 ≥ P95 (${decimal.format(p95LatencyMs)} ms)`,
                        metric: 'latency',
                        threshold: p95LatencyMs,
                      })
                    }
                  >
                    P95
                  </button>
                  <button
                    type="button"
                    disabled={summary.calls === 0}
                    onClick={() =>
                      void loadDrilldown({
                        label: `延迟 ≥ P99 (${decimal.format(p99LatencyMs)} ms)`,
                        metric: 'latency',
                        threshold: p99LatencyMs,
                      })
                    }
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
            modelPoints={data.modelSeries ?? []}
            models={data.models}
            range={range}
            metric={chartMetric}
            grouping={chartGrouping}
            onMetricChange={setChartMetric}
            onGroupingChange={setChartGrouping}
            onBucketSelect={selectBucket}
          />

          <section className="panel flush-panel model-breakdown-panel">
            <div className="panel-heading compact-panel-heading">
              <h2>模型明细</h2>
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
                          {integer.format(model.calls)}
                          <small>
                            {decimal.format(successRate(model.calls, model.successfulCalls))}% 成功
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
                        暂无模型调用
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : null}

      {activeTab === 'logs' ? (
        <div
          id="key-panel-logs"
          className="key-tab-panel"
          role="tabpanel"
          aria-labelledby="key-tab-logs"
        >
          <section className="panel flush-panel logs-panel" id="key-usage-logs">
            <div className="logs-toolbar">
              <label className="log-search">
                <Search size={14} />
                <input
                  value={logSearch}
                  onChange={(event) => setLogSearch(event.target.value)}
                  placeholder="请求 ID、模型、错误码"
                  aria-label="搜索调用记录"
                />
              </label>
              <select
                className="input log-filter-select"
                value={logStatus}
                onChange={(event) => setLogStatus(event.target.value as LogStatusFilter)}
                aria-label="按状态筛选"
              >
                <option value="all">全部状态</option>
                <option value="success">成功</option>
                <option value="failed">失败</option>
              </select>
              <select
                className="input log-filter-select model-filter"
                value={logModel}
                onChange={(event) => setLogModel(event.target.value)}
                aria-label="按模型筛选"
              >
                <option value="all">全部模型</option>
                {logModels.map((model) => (
                  <option value={model} key={model}>
                    {model}
                  </option>
                ))}
              </select>
              <select
                className="input log-filter-select"
                value={logEndpoint}
                onChange={(event) => setLogEndpoint(event.target.value)}
                aria-label="按端点筛选"
              >
                <option value="all">全部端点</option>
                {data.endpoints.map((endpoint) => (
                  <option value={endpoint.endpoint} key={endpoint.endpoint}>
                    {endpointLabel(endpoint.endpoint)}
                  </option>
                ))}
              </select>
              {hasLocalLogFilters ? (
                <button
                  type="button"
                  className="clear-filter-button"
                  onClick={resetLocalLogFilters}
                >
                  <X size={13} /> 重置
                </button>
              ) : null}
              <div className="logs-range-control">
                <span>{filteredLogs.length} 条</span>
                <RangeSwitch value={range} onChange={setRange} />
              </div>
            </div>
            {drilldown ? (
              <div className="drilldown-bar">
                <span>{drilldown.label}</span>
                <button type="button" onClick={clearDrilldown}>
                  <X size={13} /> 清除
                </button>
              </div>
            ) : null}
            {logsLoading ? <div className="log-query-progress">查询中…</div> : null}
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
                  {filteredLogs.length ? (
                    filteredLogs.map((log: KeyUsageLog) => (
                      <Fragment key={log.id}>
                        <tr
                          className="usage-log-row"
                          aria-expanded={expandedLogId === log.id}
                          onClick={() =>
                            setExpandedLogId((current) => (current === log.id ? undefined : log.id))
                          }
                        >
                          <td>
                            <Badge tone={log.success ? 'success' : 'danger'}>
                              {log.statusCode}
                            </Badge>
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
                              aria-label={
                                expandedLogId === log.id ? '收起调用明细' : '展开调用明细'
                              }
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
                        暂无匹配记录
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : null}

      {activeTab === 'settings' ? (
        <div
          id="key-panel-settings"
          className="key-tab-panel"
          role="tabpanel"
          aria-labelledby="key-tab-settings"
        >
          <div className="key-settings-grid">
            <section className="panel settings-section">
              <div className="panel-heading compact-panel-heading settings-section-heading">
                <h2>基本设置</h2>
                <Button
                  type="submit"
                  form="key-general-settings-form"
                  loading={savingGeneral}
                  disabled={!generalChanged}
                  aria-label="保存基本设置"
                >
                  {savedSettings === 'general' && !generalChanged ? (
                    <Check size={13} />
                  ) : (
                    <Save size={13} />
                  )}
                  {savedSettings === 'general' && !generalChanged ? '已保存' : '保存'}
                </Button>
              </div>
              <form
                id="key-general-settings-form"
                className="settings-section-body"
                onSubmit={(event) => void saveGeneral(event)}
              >
                <div className="general-settings-grid">
                  <div className="general-setting-wide">
                    <Field label="名称">
                      <Input
                        value={currentGeneral.name}
                        onChange={(event) =>
                          updateGeneralSettings({
                            ...currentGeneral,
                            name: event.target.value,
                          })
                        }
                        required
                      />
                    </Field>
                  </div>
                  <Field label="RPM">
                    <Input
                      type="number"
                      min={1}
                      max={100_000}
                      value={currentGeneral.rpmLimit}
                      onChange={(event) =>
                        updateGeneralSettings({
                          ...currentGeneral,
                          rpmLimit: event.target.value,
                        })
                      }
                      required
                    />
                  </Field>
                  <Field label="预算 USD">
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={currentGeneral.budgetUsd}
                      onChange={(event) =>
                        updateGeneralSettings({
                          ...currentGeneral,
                          budgetUsd: event.target.value,
                        })
                      }
                      placeholder="无限制"
                    />
                  </Field>
                  <div className="general-setting-wide">
                    <Field label="上游连接">
                      <select
                        className="input"
                        value={currentGeneral.providerConnectionId}
                        onChange={(event) =>
                          updateGeneralSettings({
                            ...currentGeneral,
                            providerConnectionId: event.target.value,
                          })
                        }
                      >
                        <option value="">自动路由</option>
                        {providers.map((provider) => (
                          <option value={provider.id} key={provider.id}>
                            {provider.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <div className="general-setting-wide">
                    <Field label="到期时间" hint="留空表示永不过期">
                      <Input
                        type="datetime-local"
                        value={currentGeneral.expiresAt}
                        onChange={(event) =>
                          updateGeneralSettings({
                            ...currentGeneral,
                            expiresAt: event.target.value,
                          })
                        }
                      />
                    </Field>
                  </div>
                </div>
              </form>
            </section>

            <section className="panel settings-section langfuse-settings-section">
              <div className="panel-heading compact-panel-heading settings-section-heading">
                <h2>Langfuse</h2>
                <Button
                  type="submit"
                  form="key-langfuse-settings-form"
                  loading={savingLangfuse}
                  disabled={!langfuseChanged}
                  aria-label="保存 Langfuse 设置"
                >
                  {savedSettings === 'langfuse' && !langfuseChanged ? (
                    <Check size={13} />
                  ) : (
                    <Save size={13} />
                  )}
                  {savedSettings === 'langfuse' && !langfuseChanged ? '已保存' : '保存'}
                </Button>
              </div>
              <form
                id="key-langfuse-settings-form"
                className="settings-section-body"
                onSubmit={(event) => void saveLangfuse(event)}
              >
                <LangfuseFields
                  value={langfuseSettings}
                  onChange={updateLangfuseSettings}
                  hasSecretKey={key.langfuse.hasSecretKey}
                  switchLabel="启用"
                  switchHint="为此 Key 独立记录"
                />
              </form>
            </section>
          </div>

          <section className="panel flush-panel pricing-panel">
            <div className="panel-heading pricing-heading">
              <div>
                <h2>模型价格</h2>
                <span className="panel-note">USD / 1M tokens · 仅影响后续调用</span>
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
                      const initialDraft = priceDraft(price);
                      const draft = priceDrafts[draftKey] ?? initialDraft;
                      const changed = (
                        ['inputPerMillion', 'cachedInputPerMillion', 'outputPerMillion'] as const
                      ).some((field) => draft[field] !== initialDraft[field]);
                      return (
                        <tr key={draftKey}>
                          <td>
                            <strong>{price.model}</strong>
                            <small>{price.provider}</small>
                          </td>
                          {(
                            [
                              'inputPerMillion',
                              'cachedInputPerMillion',
                              'outputPerMillion',
                            ] as const
                          ).map((field) => (
                            <td key={field}>
                              <input
                                className="price-input"
                                type="number"
                                min="0"
                                step="0.000001"
                                value={draft[field]}
                                required
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
                              disabled={!changed}
                              aria-label={`保存 ${price.model} 价格`}
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
                        有模型调用后可配置价格
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
