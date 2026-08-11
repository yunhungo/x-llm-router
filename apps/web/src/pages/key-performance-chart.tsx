import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { KeyAnalyticsRange, KeyModelUsage, KeyModelUsagePoint, KeyUsagePoint } from '../types';

export type PerformanceMetric = 'calls' | 'cache' | 'tps' | 'ttft' | 'latency' | 'tokens' | 'cost';
export type ChartGrouping = 'total' | 'model';

interface ModelChartSeries {
  identity: string;
  dataKey: string;
  label: string;
  color: string;
}

export interface GroupedChartDatum {
  bucket: string;
  [key: string]: string | number | null;
}

const metricOptions: Array<{ value: PerformanceMetric; label: string }> = [
  { value: 'calls', label: '调用' },
  { value: 'cache', label: '缓存命中' },
  { value: 'tps', label: 'TPS' },
  { value: 'ttft', label: 'TTFT' },
  { value: 'latency', label: '延迟' },
  { value: 'tokens', label: 'Token' },
  { value: 'cost', label: '成本' },
];

const modelColors = [
  'var(--chart-blue)',
  'var(--chart-teal)',
  'var(--chart-purple)',
  'var(--chart-amber)',
  'var(--chart-red)',
  'var(--chart-slate)',
];

const seriesNames: Record<string, string> = {
  successfulCalls: '成功调用',
  failedCalls: '失败调用',
  cacheRate: '缓存命中率',
  p10Tps: 'P10 TPS（慢尾）',
  p50Tps: 'P50 TPS',
  p50TtftMs: 'P50 TTFT',
  p95TtftMs: 'P95 TTFT',
  p99TtftMs: 'P99 TTFT',
  p50LatencyMs: 'P50 延迟',
  p95LatencyMs: 'P95 延迟',
  p99LatencyMs: 'P99 延迟',
  inputTokens: '输入 Token',
  outputTokens: '输出 Token',
  costUsd: '成本',
};

function modelIdentity(provider: string, model: string) {
  return `${provider}\u0000${model}`;
}

function modelChartSeries(models: KeyModelUsage[]): ModelChartSeries[] {
  const duplicateModels = new Set(
    models
      .filter((model, index) => models.findIndex((item) => item.model === model.model) !== index)
      .map((model) => model.model),
  );

  return models.slice(0, modelColors.length).map((model, index) => ({
    identity: modelIdentity(model.provider, model.model),
    dataKey: `model_${index}`,
    label: duplicateModels.has(model.model) ? `${model.provider} / ${model.model}` : model.model,
    color: modelColors[index] ?? 'var(--chart-slate)',
  }));
}

function compact(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatPerformanceValue(metric: PerformanceMetric, value: number): string {
  if (metric === 'cache') return `${value.toFixed(1)}%`;
  if (metric === 'ttft' || metric === 'latency') return `${value.toFixed(1)} ms`;
  if (metric === 'tps') return `${value.toFixed(1)} token/s`;
  if (metric === 'cost') {
    const digits = value > 0 && value < 0.0001 ? 8 : value < 0.01 ? 6 : 4;
    return `$${value.toFixed(digits)}`;
  }
  return compact(value);
}

function axisValue(metric: PerformanceMetric, value: number): string {
  if (metric === 'cache') return `${value}%`;
  if (metric === 'ttft' || metric === 'latency') return `${compact(value)}ms`;
  if (metric === 'cost') {
    if (value === 0) return '$0';
    if (Math.abs(value) < 0.0001) return `$${value.toExponential(1)}`;
    if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
    if (Math.abs(value) < 1) return `$${value.toFixed(2)}`;
    return `$${compact(value)}`;
  }
  return compact(value);
}

function tickLabel(value: string, range: KeyAnalyticsRange): string {
  const date = new Date(value);
  if (range === '24h') {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  if (range === '7d') {
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
    });
  }
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function fullTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function finiteMetric(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function normalizePerformancePoint(point: KeyUsagePoint) {
  const calls = finiteMetric(point.calls);
  const failedCalls = finiteMetric(point.failedCalls);
  const successfulCalls = finiteMetric(point.successfulCalls, Math.max(calls - failedCalls, 0));
  const inputTokens = finiteMetric(point.inputTokens, finiteMetric(point.tokens));
  const outputTokens = finiteMetric(point.outputTokens);
  const p50Tps = finiteMetric(point.p50Tps, finiteMetric(point.averageTps));
  const p10Tps = finiteMetric(point.p10Tps, p50Tps);
  const p50TtftMs = finiteMetric(point.p50TtftMs, finiteMetric(point.averageTtftMs));
  const p95TtftMs = finiteMetric(point.p95TtftMs, p50TtftMs);
  const p99TtftMs = finiteMetric(point.p99TtftMs, p95TtftMs);
  const p50LatencyMs = finiteMetric(point.p50LatencyMs, finiteMetric(point.averageLatencyMs));
  const p95LatencyMs = finiteMetric(point.p95LatencyMs, p50LatencyMs);
  const p99LatencyMs = finiteMetric(point.p99LatencyMs, p95LatencyMs);

  return {
    ...point,
    calls,
    successfulCalls,
    failedCalls,
    inputTokens,
    outputTokens,
    cacheRate: inputTokens ? (finiteMetric(point.cachedTokens) / inputTokens) * 100 : 0,
    p10Tps: p10Tps || null,
    p50Tps: p50Tps || null,
    p50TtftMs: p50TtftMs || null,
    p95TtftMs: p95TtftMs || null,
    p99TtftMs: p99TtftMs || null,
    p50LatencyMs: calls ? p50LatencyMs : null,
    p95LatencyMs: calls ? p95LatencyMs : null,
    p99LatencyMs: calls ? p99LatencyMs : null,
  };
}

function groupedMetricValue(point: KeyModelUsagePoint, metric: PerformanceMetric) {
  if (metric === 'calls') return finiteMetric(point.calls);
  if (metric === 'tokens')
    return finiteMetric(point.inputTokens) + finiteMetric(point.outputTokens);
  if (metric === 'cost') return finiteMetric(point.costUsd);
  if (metric === 'cache') {
    const input = finiteMetric(point.inputTokens);
    return input ? (finiteMetric(point.cachedTokens) / input) * 100 : null;
  }
  if (metric === 'tps') return finiteMetric(point.averageTps) || null;
  if (metric === 'ttft') return finiteMetric(point.averageTtftMs) || null;
  return finiteMetric(point.averageLatencyMs) || null;
}

export function buildGroupedChartData(
  points: KeyUsagePoint[],
  modelPoints: KeyModelUsagePoint[],
  series: Array<Pick<ModelChartSeries, 'identity' | 'dataKey'>>,
  metric: PerformanceMetric,
): GroupedChartDatum[] {
  const additive = metric === 'calls' || metric === 'tokens' || metric === 'cost';
  const seriesByIdentity = new Map(series.map((item) => [item.identity, item]));
  const rows = new Map(
    points.map((point) => [
      point.bucket,
      Object.fromEntries([
        ['bucket', point.bucket],
        ...series.map((item) => [item.dataKey, additive ? 0 : null]),
      ]) as GroupedChartDatum,
    ]),
  );

  modelPoints.forEach((point) => {
    const chartSeries = seriesByIdentity.get(modelIdentity(point.provider, point.model));
    const row = rows.get(point.bucket);
    if (chartSeries && row) row[chartSeries.dataKey] = groupedMetricValue(point, metric);
  });

  return [...rows.values()];
}

function GroupedSeries({
  metric,
  series,
}: {
  metric: PerformanceMetric;
  series: ModelChartSeries[];
}) {
  const isAdditive = metric === 'calls' || metric === 'tokens' || metric === 'cost';
  if (isAdditive) {
    return series.map((item) => (
      <Area
        key={item.dataKey}
        type="monotone"
        dataKey={item.dataKey}
        stackId="models"
        stroke={item.color}
        fill={item.color}
        fillOpacity={0.2}
        strokeWidth={1.8}
        activeDot={{ r: 4 }}
      />
    ));
  }
  return series.map((item) => (
    <Line
      key={item.dataKey}
      type="monotone"
      dataKey={item.dataKey}
      stroke={item.color}
      strokeWidth={2}
      dot={false}
      connectNulls
      activeDot={{ r: 4 }}
    />
  ));
}

export function KeyPerformanceChart({
  points,
  modelPoints,
  models,
  range,
  metric,
  grouping,
  onMetricChange,
  onGroupingChange,
  onBucketSelect,
}: {
  points: KeyUsagePoint[];
  modelPoints: KeyModelUsagePoint[];
  models: KeyModelUsage[];
  range: KeyAnalyticsRange;
  metric: PerformanceMetric;
  grouping: ChartGrouping;
  onMetricChange: (metric: PerformanceMetric) => void;
  onGroupingChange: (grouping: ChartGrouping) => void;
  onBucketSelect: (point: KeyUsagePoint) => void;
}) {
  const totalChartData = points.map(normalizePerformancePoint);
  const groupedSeries = modelChartSeries(models);
  const groupedChartData = buildGroupedChartData(points, modelPoints, groupedSeries, metric);
  const chartData = grouping === 'model' ? groupedChartData : totalChartData;
  const hasCalls = points.some((point) => point.calls > 0);
  const groupedNames = Object.fromEntries(groupedSeries.map((item) => [item.dataKey, item.label]));

  return (
    <section className="panel performance-chart-panel detail-section">
      <div className="performance-chart-heading">
        <div className="chart-title-row">
          <h2>趋势</h2>
          {grouping === 'model' && models.length > modelColors.length ? (
            <span>调用量前 {modelColors.length} 个模型</span>
          ) : null}
        </div>
        <div className="chart-controls">
          <div className="chart-grouping" aria-label="图表分类方式">
            <button
              type="button"
              className={grouping === 'total' ? 'active' : ''}
              onClick={() => onGroupingChange('total')}
            >
              汇总
            </button>
            <button
              type="button"
              className={grouping === 'model' ? 'active' : ''}
              disabled={!groupedSeries.length}
              onClick={() => onGroupingChange('model')}
            >
              按模型
            </button>
          </div>
          <div className="metric-tabs" aria-label="图表指标">
            {metricOptions.map((option) => (
              <button
                type="button"
                key={option.value}
                className={metric === option.value ? 'active' : ''}
                onClick={() => onMetricChange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {hasCalls ? (
        <div className="performance-chart" role="img" aria-label={`${metric} 时间序列图`}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={chartData}
              margin={{ top: 12, right: 14, bottom: 4, left: 2 }}
              onClick={(state: unknown) => {
                const activeLabel = (state as { activeLabel?: string } | undefined)?.activeLabel;
                const point = points.find((item) => item.bucket === activeLabel);
                if (point?.calls) onBucketSelect(point);
              }}
            >
              <CartesianGrid stroke="var(--hairline)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="bucket"
                tickFormatter={(value: string) => tickLabel(value, range)}
                tick={{ fill: 'var(--mute)', fontSize: 10 }}
                tickLine={false}
                axisLine={{ stroke: 'var(--hairline-strong)' }}
                minTickGap={28}
              />
              <YAxis
                width={58}
                tickFormatter={(value: number) => axisValue(metric, value)}
                tick={{ fill: 'var(--mute)', fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                domain={metric === 'cache' ? [0, 100] : [0, 'auto']}
              />
              <Tooltip
                cursor={{ stroke: 'var(--ink)', strokeDasharray: '3 3' }}
                labelFormatter={(value) => fullTime(String(value))}
                formatter={(value, name) => [
                  formatPerformanceValue(metric, Number(value ?? 0)),
                  groupedNames[String(name)] ?? seriesNames[String(name)] ?? String(name),
                ]}
                contentStyle={{
                  border: '1px solid var(--hairline-strong)',
                  borderRadius: 8,
                  background: 'var(--canvas)',
                  boxShadow: 'var(--shadow-3)',
                  fontSize: 11,
                }}
              />
              <Legend
                formatter={(value: string) => groupedNames[value] ?? seriesNames[value] ?? value}
                wrapperStyle={{ fontSize: 10, paddingTop: 8 }}
              />

              {grouping === 'model' ? (
                <GroupedSeries metric={metric} series={groupedSeries} />
              ) : (
                <>
                  {metric === 'calls' ? (
                    <>
                      <Bar
                        dataKey="successfulCalls"
                        stackId="calls"
                        fill="var(--ink)"
                        maxBarSize={28}
                        radius={[0, 0, 3, 3]}
                      />
                      <Bar
                        dataKey="failedCalls"
                        stackId="calls"
                        fill="var(--chart-red)"
                        maxBarSize={28}
                        radius={[3, 3, 0, 0]}
                      />
                    </>
                  ) : null}
                  {metric === 'cache' ? (
                    <Area
                      type="monotone"
                      dataKey="cacheRate"
                      stroke="var(--chart-teal)"
                      fill="var(--chart-teal)"
                      fillOpacity={0.14}
                      strokeWidth={2}
                      activeDot={{ r: 5 }}
                    />
                  ) : null}
                  {metric === 'tps' ? (
                    <>
                      <Line
                        type="monotone"
                        dataKey="p10Tps"
                        stroke="var(--chart-amber)"
                        strokeWidth={2}
                        dot={false}
                        connectNulls
                      />
                      <Line
                        type="monotone"
                        dataKey="p50Tps"
                        stroke="var(--blue)"
                        strokeWidth={2}
                        dot={false}
                        connectNulls
                      />
                    </>
                  ) : null}
                  {metric === 'ttft' ? (
                    <>
                      <Line
                        type="monotone"
                        dataKey="p50TtftMs"
                        stroke="var(--chart-teal)"
                        strokeWidth={2}
                        dot={false}
                        connectNulls
                      />
                      <Line
                        type="monotone"
                        dataKey="p95TtftMs"
                        stroke="var(--chart-amber)"
                        strokeWidth={2}
                        dot={false}
                        connectNulls
                      />
                      <Line
                        type="monotone"
                        dataKey="p99TtftMs"
                        stroke="var(--chart-red)"
                        strokeWidth={2}
                        dot={false}
                        connectNulls
                      />
                    </>
                  ) : null}
                  {metric === 'latency' ? (
                    <>
                      <Line
                        type="monotone"
                        dataKey="p50LatencyMs"
                        stroke="var(--chart-teal)"
                        strokeWidth={2}
                        dot={false}
                        connectNulls
                      />
                      <Line
                        type="monotone"
                        dataKey="p95LatencyMs"
                        stroke="var(--chart-amber)"
                        strokeWidth={2}
                        dot={false}
                        connectNulls
                      />
                      <Line
                        type="monotone"
                        dataKey="p99LatencyMs"
                        stroke="var(--chart-red)"
                        strokeWidth={2}
                        dot={false}
                        connectNulls
                      />
                    </>
                  ) : null}
                  {metric === 'tokens' ? (
                    <>
                      <Area
                        type="monotone"
                        dataKey="inputTokens"
                        stackId="tokens"
                        stroke="var(--chart-slate)"
                        fill="var(--chart-slate)"
                        fillOpacity={0.16}
                      />
                      <Area
                        type="monotone"
                        dataKey="outputTokens"
                        stackId="tokens"
                        stroke="var(--blue)"
                        fill="var(--blue)"
                        fillOpacity={0.18}
                      />
                    </>
                  ) : null}
                  {metric === 'cost' ? (
                    <Area
                      type="monotone"
                      dataKey="costUsd"
                      stroke="var(--chart-purple)"
                      fill="var(--chart-purple)"
                      fillOpacity={0.15}
                      strokeWidth={2}
                      activeDot={{ r: 5 }}
                    />
                  ) : null}
                </>
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="analytics-empty performance-empty">暂无调用</div>
      )}
    </section>
  );
}
