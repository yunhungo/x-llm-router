import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { KeyRound, RefreshCcw } from 'lucide-react';
import { useParams, useSearchParams } from 'react-router-dom';

import { api, ApiError, jsonBody } from '../../api';
import type { PerformanceMetric } from '../../components/key-performance-chart';
import {
  emptyLangfuse,
  langfuseDraft,
  langfusePayload,
  type LangfuseDraft,
} from '../../components/langfuse-fields';
import { Badge, Button, PageHeader, Skeleton } from '../../components/ui';
import type {
  KeyAnalyticsRange,
  KeyAnalyticsResponse,
  KeyUsageLog,
  KeyUsagePoint,
  Provider,
} from '../../types';
import {
  createDefaultUsageLogFilters,
  usageLogFilterSearchParams,
  usageLogTimeRangeError,
} from '../../features/usage/usage-log-pagination';
import {
  useDebouncedValue,
  useUsageLogPagination,
} from '../../features/usage/use-usage-log-pagination';
import { ChartsPanel } from './components/charts-panel';
import { KeyDetailTabs } from './components/key-detail-tabs';
import { LogsPanel } from './components/logs-panel';
import { MiddlewarePanel } from './components/middleware-panel';
import { OverviewPanel } from './components/overview-panel';
import { SettingsPanel } from './components/settings-panel';
import {
  allModelsValue,
  analyticsModelOptions,
  detailTabSearchParams,
  formatDate,
  generalDraft,
  parseDetailTab,
  parseModelIdentity,
  sameGeneralDraft,
  sameLangfuseDraft,
  type DetailTab,
  type GeneralDraft,
  type LogDrilldown,
  type ModelAnalyticsState,
} from './key-detail-model';
import './key-detail.css';

const analyticsRangeMs: Record<KeyAnalyticsRange, number> = {
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};

function analyticsLogTimeRange(range: KeyAnalyticsRange, now = new Date()) {
  return {
    from: new Date(now.getTime() - analyticsRangeMs[range]).toISOString(),
    to: now.toISOString(),
  };
}

export function KeyDetailPage() {
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = parseDetailTab(searchParams.get('tab'));
  const setActiveTab = useCallback(
    (nextTab: DetailTab) => {
      setSearchParams((current) => detailTabSearchParams(current, nextTab));
    },
    [setSearchParams],
  );
  const [range, setRange] = useState<KeyAnalyticsRange>('24h');
  const [data, setData] = useState<KeyAnalyticsResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [providers, setProviders] = useState<Provider[]>([]);
  const [generalSettings, setGeneralSettings] = useState<GeneralDraft>();
  const [savingGeneral, setSavingGeneral] = useState(false);
  const [langfuseSettings, setLangfuseSettings] = useState<LangfuseDraft>(emptyLangfuse);
  const [savingLangfuse, setSavingLangfuse] = useState(false);
  const [savedSettings, setSavedSettings] = useState<'general' | 'langfuse'>();
  const [expandedLogId, setExpandedLogId] = useState<string>();
  const [chartMetric, setChartMetric] = useState<PerformanceMetric>('calls');
  const [chartModel, setChartModel] = useState(allModelsValue);
  const [modelAnalytics, setModelAnalytics] = useState<ModelAnalyticsState>();
  const [modelAnalyticsLoading, setModelAnalyticsLoading] = useState(false);
  const [modelAnalyticsError, setModelAnalyticsError] = useState('');
  const [chartRefreshKey, setChartRefreshKey] = useState(0);
  const modelAnalyticsRequest = useRef(0);
  const mainLoadRequest = useRef(0);
  const mainLoadController = useRef<AbortController | undefined>(undefined);
  const [drilldown, setDrilldown] = useState<LogDrilldown>();
  const [logFilters, setLogFilters] = useState(createDefaultUsageLogFilters);
  const debouncedLogSearch = useDebouncedValue(logFilters.search);
  const logTimeError = usageLogTimeRangeError(logFilters);
  const logQuery = useMemo(() => {
    if (!id || logTimeError) return '';
    const params = usageLogFilterSearchParams({
      ...logFilters,
      search: debouncedLogSearch,
    });
    params.set('keyId', id);
    if (drilldown) {
      params.set('metric', drilldown.metric);
      if (drilldown.threshold !== undefined) params.set('threshold', String(drilldown.threshold));
      if (drilldown.provider) params.set('provider', drilldown.provider);
    }
    return params.toString();
  }, [debouncedLogSearch, drilldown, id, logFilters, logTimeError]);
  const logPagination = useUsageLogPagination<KeyUsageLog>({
    query: logQuery,
    enabled: activeTab === 'logs' && Boolean(id) && !logTimeError,
  });

  const load = useCallback(async () => {
    if (!id) return;
    const requestId = ++mainLoadRequest.current;
    mainLoadController.current?.abort();
    const controller = new AbortController();
    mainLoadController.current = controller;
    setLoading(true);
    setData((current) => (current?.key.id === id && current.range === range ? current : undefined));
    setError('');
    try {
      const [response, providerResponse] = await Promise.all([
        api<KeyAnalyticsResponse>(`/api/admin/keys/${id}/analytics?range=${range}`, {
          signal: controller.signal,
        }),
        api<{ providers: Provider[] }>('/api/admin/providers', { signal: controller.signal }),
      ]);
      if (mainLoadRequest.current !== requestId) return;
      setData(response);
      setProviders(providerResponse.providers.filter((provider) => provider.status === 'active'));
      setGeneralSettings(generalDraft(response.key));
      setLangfuseSettings(langfuseDraft(response.key.langfuse));
    } catch (caught) {
      if (mainLoadRequest.current !== requestId) return;
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(caught instanceof ApiError ? caught.message : '调用数据加载失败。');
    } finally {
      if (mainLoadRequest.current === requestId) {
        if (mainLoadController.current === controller) mainLoadController.current = undefined;
        setLoading(false);
      }
    }
  }, [id, range]);

  useEffect(() => {
    void load();
    return () => {
      mainLoadController.current?.abort();
      mainLoadRequest.current += 1;
    };
  }, [load]);

  const chartModelOptions = useMemo(
    () => (data && data.key.id === id ? analyticsModelOptions(data, providers) : []),
    [data, id, providers],
  );

  useEffect(() => {
    setChartModel(allModelsValue);
  }, [id]);

  useEffect(() => {
    setLogFilters(createDefaultUsageLogFilters());
    setDrilldown(undefined);
    setExpandedLogId(undefined);
  }, [id]);

  useEffect(() => setExpandedLogId(undefined), [logQuery]);

  useEffect(() => {
    if (!data || data.key.id !== id) return;
    setChartModel((current) => {
      if (current === allModelsValue) return current;
      if (chartModelOptions.some((option) => option.identity === current)) return current;
      return allModelsValue;
    });
  }, [chartModelOptions, data, id]);

  useEffect(() => {
    if (
      (activeTab !== 'overview' && activeTab !== 'charts') ||
      !id ||
      chartModel === allModelsValue
    ) {
      setModelAnalyticsError('');
      setModelAnalyticsLoading(false);
      return;
    }
    const selectedModel = parseModelIdentity(chartModel);
    if (!selectedModel) return;

    const requestId = ++modelAnalyticsRequest.current;
    const controller = new AbortController();
    const params = new URLSearchParams({
      range,
      model: selectedModel.model,
      provider: selectedModel.provider,
    });
    setModelAnalyticsLoading(true);
    setModelAnalyticsError('');

    void api<KeyAnalyticsResponse>(`/api/admin/keys/${id}/analytics?${params.toString()}`, {
      signal: controller.signal,
    })
      .then((response) => {
        if (modelAnalyticsRequest.current !== requestId) return;
        setModelAnalytics({ keyId: id, identity: chartModel, range, data: response });
      })
      .catch((caught: unknown) => {
        if (modelAnalyticsRequest.current !== requestId) return;
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setModelAnalyticsError(caught instanceof ApiError ? caught.message : '模型数据加载失败。');
      })
      .finally(() => {
        if (modelAnalyticsRequest.current === requestId) setModelAnalyticsLoading(false);
      });

    return () => {
      controller.abort();
      if (modelAnalyticsRequest.current === requestId) modelAnalyticsRequest.current += 1;
    };
  }, [activeTab, chartModel, chartRefreshKey, id, range]);

  const loadDrilldown = (next: LogDrilldown) => {
    if (!id) return;
    const fallbackRange = analyticsLogTimeRange(range);
    setActiveTab('logs');
    setError('');
    setDrilldown(next);
    setExpandedLogId(undefined);
    setLogFilters({
      ...createDefaultUsageLogFilters(),
      from: next.from ?? fallbackRange.from,
      to: next.to ?? fallbackRange.to,
      model: next.model ?? 'all',
    });
    requestAnimationFrame(() =>
      document.getElementById('key-usage-logs')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      }),
    );
  };

  const clearDrilldown = () => {
    setDrilldown(undefined);
    setLogFilters(createDefaultUsageLogFilters());
    setExpandedLogId(undefined);
  };

  const selectBucket = (point: KeyUsagePoint) => {
    const selectedModel = parseModelIdentity(chartModel);
    loadDrilldown({
      label: formatDate(point.bucket),
      metric: 'recent',
      from: point.bucket,
      to: point.bucketEnd,
      ...selectedModel,
    });
  };

  const loadModelDrilldown = (next: LogDrilldown) => {
    const selectedModel = parseModelIdentity(chartModel);
    loadDrilldown({ ...next, ...selectedModel });
  };

  const saveGeneral = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!id || !generalSettings) return;
    const rpmLimit = Number(generalSettings.rpmLimit);
    const budgetUsd = generalSettings.budgetUsd === '' ? null : Number(generalSettings.budgetUsd);
    if (!generalSettings.name.trim()) {
      setError('名称不能为空。');
      return;
    }
    if (!Number.isInteger(rpmLimit) || rpmLimit < 0 || rpmLimit > 100_000) {
      setError('RPM 必须是 0 到 100000 之间的整数，0 表示不限制。');
      return;
    }
    if (budgetUsd !== null && (!Number.isFinite(budgetUsd) || budgetUsd < 0)) {
      setError('预算必须是大于或等于 0 的数字。');
      return;
    }
    setSavingGeneral(true);
    setError('');
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
      setSavedSettings('general');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '基本设置保存失败。');
    } finally {
      setSavingGeneral(false);
    }
  };

  const saveLangfuse = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!id) return;
    setSavingLangfuse(true);
    setError('');
    try {
      await api(`/api/admin/keys/${id}/langfuse`, {
        method: 'PUT',
        ...jsonBody({
          ...langfusePayload(langfuseSettings),
          secretKey: langfuseSettings.secretKey || undefined,
        }),
      });
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

  const { key } = data;
  const selectedModelOption = chartModelOptions.find((option) => option.identity === chartModel);
  const activeModelData =
    chartModel !== allModelsValue
      ? modelAnalytics &&
        modelAnalytics.keyId === id &&
        modelAnalytics.identity === chartModel &&
        modelAnalytics.range === range
        ? modelAnalytics.data
        : undefined
      : data.key.id === id
        ? data
        : undefined;
  const resetLocalLogFilters = () => {
    setDrilldown(undefined);
    setLogFilters(createDefaultUsageLogFilters());
  };
  const currentGeneral = generalSettings ?? generalDraft(key);
  const generalChanged = !sameGeneralDraft(currentGeneral, generalDraft(key));
  const langfuseChanged = !sameLangfuseDraft(langfuseSettings, langfuseDraft(key.langfuse));
  const updateGeneralSettings = (next: GeneralDraft) => {
    setGeneralSettings(next);
    setSavedSettings((current) => (current === 'general' ? undefined : current));
  };
  const updateLangfuseSettings = (next: LangfuseDraft) => {
    setLangfuseSettings(next);
    setSavedSettings((current) => (current === 'langfuse' ? undefined : current));
  };
  const toggleExpandedLog = (logId: string) => {
    setExpandedLogId((current) => (current === logId ? undefined : logId));
  };

  return (
    <div
      className={`page-wrap key-detail-page${activeTab === 'middleware' ? ' key-detail-page-fill' : ''}`}
    >
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
            <Button
              variant="secondary"
              loading={loading}
              onClick={() => {
                setChartRefreshKey((current) => current + 1);
                void load();
                if (activeTab === 'logs' && !logTimeError) void logPagination.refresh();
              }}
            >
              <RefreshCcw size={14} /> 刷新
            </Button>
          </div>
        }
      />

      <KeyDetailTabs value={activeTab} onChange={setActiveTab} />

      {error ? <div className="form-error detail-message">{error}</div> : null}

      {activeTab === 'overview' ? (
        <OverviewPanel
          apiKey={key}
          range={range}
          modelOptions={chartModelOptions}
          selectedModel={chartModel}
          onSelectedModelChange={setChartModel}
          summary={activeModelData?.summary}
          loading={modelAnalyticsLoading}
          error={modelAnalyticsError}
          onRetry={() => setChartRefreshKey((value) => value + 1)}
        />
      ) : null}

      {activeTab === 'charts' ? (
        <ChartsPanel
          apiKey={key}
          range={range}
          onRangeChange={setRange}
          modelOptions={chartModelOptions}
          selectedModel={chartModel}
          selectedModelOption={selectedModelOption}
          onSelectedModelChange={setChartModel}
          data={activeModelData}
          loading={modelAnalyticsLoading}
          error={modelAnalyticsError}
          onRetry={() => setChartRefreshKey((value) => value + 1)}
          metric={chartMetric}
          onMetricChange={setChartMetric}
          onBucketSelect={selectBucket}
          onDrilldown={loadModelDrilldown}
        />
      ) : null}

      {activeTab === 'logs' ? (
        <LogsPanel
          logs={logPagination.logs}
          modelNames={logPagination.facets.models}
          endpoints={logPagination.facets.endpoints}
          filters={logFilters}
          onFiltersChange={setLogFilters}
          timeError={logTimeError}
          onResetFilters={resetLocalLogFilters}
          drilldown={drilldown}
          onClearDrilldown={clearDrilldown}
          loading={logPagination.refreshing}
          error={logPagination.error}
          onRetry={() => void logPagination.refresh()}
          loadingMore={logPagination.loadingMore}
          loadMoreError={logPagination.loadMoreError}
          onRetryLoadMore={() => void logPagination.retryLoadMore()}
          scrollContainerRef={logPagination.containerRef}
          onScroll={logPagination.onScroll}
          expandedLogId={expandedLogId}
          onToggleExpandedLog={toggleExpandedLog}
        />
      ) : null}

      {activeTab === 'settings' ? (
        <SettingsPanel
          apiKey={key}
          providers={providers}
          generalSettings={currentGeneral}
          onGeneralSettingsChange={updateGeneralSettings}
          generalChanged={generalChanged}
          savingGeneral={savingGeneral}
          onSaveGeneral={(event) => void saveGeneral(event)}
          langfuseSettings={langfuseSettings}
          onLangfuseSettingsChange={updateLangfuseSettings}
          langfuseChanged={langfuseChanged}
          savingLangfuse={savingLangfuse}
          onSaveLangfuse={(event) => void saveLangfuse(event)}
          savedSettings={savedSettings}
        />
      ) : null}

      {activeTab === 'middleware' ? <MiddlewarePanel keyId={key.id} /> : null}
    </div>
  );
}
