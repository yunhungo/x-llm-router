import { CircleDollarSign, Gauge, Timer, Zap } from 'lucide-react';

import {
  KeyPerformanceChart,
  type PerformanceMetric,
} from '../../../../components/key-performance-chart';
import { Button, Skeleton } from '../../../../components/ui';
import { DateRangePicker } from '../../../../components/date-range-picker';
import type { DateRange } from '../../../../date-range';
import type { KeyAnalyticsRange, KeyAnalyticsResponse, KeyUsagePoint } from '../../../../types';
import {
  allModelsValue,
  decimal,
  finiteMetric,
  integer,
  money,
  rangeLabels,
  successRate,
  type AnalyticsModelOption,
  type LogDrilldown,
} from '../../key-detail-model';
import { RangeSwitch } from '../range-switch';
import { TokenHeatmap } from '../token-heatmap';
import './charts-panel.css';

interface ChartsPanelProps {
  apiKey: KeyAnalyticsResponse['key'];
  range: KeyAnalyticsRange;
  timeRange: DateRange;
  customRange: boolean;
  onCustomRangeChange: (range: DateRange) => void;
  onRangeChange: (range: KeyAnalyticsRange) => void;
  modelOptions: AnalyticsModelOption[];
  selectedModel: string;
  selectedModelOption: AnalyticsModelOption | undefined;
  onSelectedModelChange: (identity: string) => void;
  data: KeyAnalyticsResponse | undefined;
  loading: boolean;
  error: string;
  onRetry: () => void;
  metric: PerformanceMetric;
  onMetricChange: (metric: PerformanceMetric) => void;
  onBucketSelect: (point: KeyUsagePoint) => void;
  onDrilldown: (drilldown: LogDrilldown) => void;
  refreshKey: number;
  onDailyModelsLoaded: (options: AnalyticsModelOption[]) => void;
}

export function ChartsPanel({
  apiKey,
  range,
  timeRange,
  customRange,
  onCustomRangeChange,
  onRangeChange,
  modelOptions,
  selectedModel,
  selectedModelOption,
  onSelectedModelChange,
  data,
  loading,
  error,
  onRetry,
  metric,
  onMetricChange,
  onBucketSelect,
  onDrilldown,
  refreshKey,
  onDailyModelsLoaded,
}: ChartsPanelProps) {
  const rangeLabel = customRange ? '所选时间范围' : rangeLabels[range];
  const summary = data?.summary;
  const cacheRate = summary?.inputTokens
    ? (summary.cachedInputTokens / summary.inputTokens) * 100
    : 0;
  const p50Tps = finiteMetric(summary?.p50Tps, finiteMetric(summary?.averageTps));
  const p10Tps = finiteMetric(summary?.p10Tps, p50Tps);
  const streamingCalls = finiteMetric(summary?.streamingCalls);
  const p50TtftMs = finiteMetric(summary?.p50TtftMs, finiteMetric(summary?.averageTtftMs));
  const p95TtftMs = finiteMetric(summary?.p95TtftMs, p50TtftMs);
  const p99TtftMs = finiteMetric(summary?.p99TtftMs, p95TtftMs);
  const p50LatencyMs = finiteMetric(summary?.p50LatencyMs, finiteMetric(summary?.averageLatencyMs));
  const p95LatencyMs = finiteMetric(summary?.p95LatencyMs, p50LatencyMs);
  const p99LatencyMs = finiteMetric(summary?.p99LatencyMs, p95LatencyMs);

  return (
    <div
      id="key-panel-charts"
      className="key-tab-panel"
      role="tabpanel"
      aria-labelledby="key-tab-charts"
    >
      <div className="tab-toolbar range-toolbar chart-filter-toolbar">
        <label className="chart-model-filter">
          <span>模型</span>
          <select
            className="input"
            value={selectedModel}
            disabled={!modelOptions.length}
            onChange={(event) => onSelectedModelChange(event.target.value)}
            aria-label="筛选模型"
          >
            <option value={allModelsValue}>
              {modelOptions.length ? '全部模型（汇总）' : '暂无可用模型'}
            </option>
            {modelOptions.map((option) => (
              <option value={option.identity} key={option.identity}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <DateRangePicker
          value={timeRange}
          onApply={onCustomRangeChange}
          label={customRange ? undefined : rangeLabel}
          ariaLabel="选择图表日期区间"
        />
        <RangeSwitch value={customRange ? undefined : range} onChange={onRangeChange} />
      </div>

      <TokenHeatmap
        key={apiKey.id}
        keyId={apiKey.id}
        selectedModel={selectedModel}
        refreshKey={refreshKey}
        onDrilldown={onDrilldown}
        onModelsLoaded={onDailyModelsLoaded}
      />

      {error ? (
        <section className="panel chart-model-error">
          <span>{error}</span>
          <Button variant="secondary" onClick={onRetry}>
            重试
          </Button>
        </section>
      ) : loading || !summary || !data ? (
        <Skeleton height={610} />
      ) : (
        <>
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
              <small>
                {integer.format(summary.outputTokens)} output ·{' '}
                {integer.format(summary.reasoningTokens)} reasoning
              </small>
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
                {summary.calls
                  ? `${decimal.format(successRate(summary.calls, summary.successfulCalls))}%`
                  : '—'}
              </strong>
              <small>{integer.format(summary.successfulCalls)} 次成功</small>
            </article>
          </section>

          <section className="key-performance-grid">
            <article className="metric-card">
              <span>缓存命中</span>
              <strong>{summary.inputTokens ? `${decimal.format(cacheRate)}%` : '—'}</strong>
              <small>
                {integer.format(summary.cachedInputTokens)} / {integer.format(summary.inputTokens)}{' '}
                input
              </small>
            </article>
            <article className="metric-card">
              <span>TPS</span>
              <strong>{p50Tps > 0 ? decimal.format(p50Tps) : '—'}</strong>
              <small>
                P50 · 平均 {p50Tps > 0 ? decimal.format(summary.averageTps) : '—'}
                <button
                  type="button"
                  disabled={p10Tps <= 0}
                  onClick={() =>
                    onDrilldown({
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
              <strong>{streamingCalls ? `${decimal.format(p50TtftMs)} ms` : '—'}</strong>
              <small>
                P50 · {integer.format(streamingCalls)} 次流式
                <span className="metric-query-links">
                  <button
                    type="button"
                    disabled={streamingCalls === 0}
                    onClick={() =>
                      onDrilldown({
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
                      onDrilldown({
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
              <strong>{summary.calls ? `${decimal.format(p50LatencyMs)} ms` : '—'}</strong>
              <small>
                P50 · 平均 {summary.calls ? `${decimal.format(summary.averageLatencyMs)} ms` : '—'}
                <span className="metric-query-links">
                  <button
                    type="button"
                    disabled={summary.calls === 0}
                    onClick={() =>
                      onDrilldown({
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
                      onDrilldown({
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
              <small>
                {apiKey.rpmLimit === 0 ? '不限流' : `限额 ${integer.format(apiKey.rpmLimit)}`}
              </small>
            </article>
          </section>

          <KeyPerformanceChart
            points={data.series}
            range={data.range}
            metric={metric}
            onMetricChange={onMetricChange}
            onBucketSelect={onBucketSelect}
            emptyLabel={
              selectedModelOption
                ? `该模型在${rangeLabel}暂无调用数据`
                : `${rangeLabel}暂无调用数据`
            }
          />

          <section className="panel flush-panel model-breakdown-panel">
            <div className="panel-heading compact-panel-heading">
              <h2>{selectedModelOption ? '模型信息' : '模型明细'}</h2>
              <span>{selectedModelOption?.label ?? '全部模型'}</span>
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
                        该模型在{rangeLabel}暂无调用数据
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
