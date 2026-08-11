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

import type { KeyAnalyticsRange, KeyUsagePoint } from '../types';

export type PerformanceMetric = 'calls' | 'cache' | 'tps' | 'ttft' | 'latency' | 'tokens' | 'cost';

const metricOptions: Array<{ value: PerformanceMetric; label: string }> = [
  { value: 'calls', label: '调用' },
  { value: 'cache', label: '缓存命中' },
  { value: 'tps', label: 'TPS' },
  { value: 'ttft', label: 'TTFT' },
  { value: 'latency', label: '延迟' },
  { value: 'tokens', label: 'Token' },
  { value: 'cost', label: '成本' },
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
    return `$${value < 0.01 ? value.toFixed(4) : compact(value)}`;
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

export function KeyPerformanceChart({
  points,
  range,
  metric,
  onMetricChange,
  onBucketSelect,
}: {
  points: KeyUsagePoint[];
  range: KeyAnalyticsRange;
  metric: PerformanceMetric;
  onMetricChange: (metric: PerformanceMetric) => void;
  onBucketSelect: (point: KeyUsagePoint) => void;
}) {
  const chartData = points.map(normalizePerformancePoint);
  const hasCalls = points.some((point) => point.calls > 0);

  return (
    <section className="panel performance-chart-panel detail-section">
      <div className="performance-chart-heading">
        <div>
          <h2>性能趋势</h2>
          <span>点击时间桶，下钻到该时段的具体请求</span>
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
                  seriesNames[String(name)] ?? String(name),
                ]}
                contentStyle={{
                  border: '1px solid var(--hairline-strong)',
                  borderRadius: 8,
                  background: 'var(--canvas)',
                  boxShadow: '0 12px 30px rgba(0, 0, 0, 0.12)',
                  fontSize: 11,
                }}
              />
              <Legend
                formatter={(value: string) => seriesNames[value] ?? value}
                wrapperStyle={{ fontSize: 10, paddingTop: 8 }}
              />

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
                    fill="#dc5a5a"
                    maxBarSize={28}
                    radius={[3, 3, 0, 0]}
                  />
                </>
              ) : null}
              {metric === 'cache' ? (
                <Area
                  type="monotone"
                  dataKey="cacheRate"
                  stroke="#0f766e"
                  fill="rgba(15, 118, 110, 0.14)"
                  strokeWidth={2}
                  activeDot={{ r: 5 }}
                />
              ) : null}
              {metric === 'tps' ? (
                <>
                  <Line
                    type="monotone"
                    dataKey="p10Tps"
                    stroke="#d97706"
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
                    stroke="#0f766e"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                  <Line
                    type="monotone"
                    dataKey="p95TtftMs"
                    stroke="#d97706"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                  <Line
                    type="monotone"
                    dataKey="p99TtftMs"
                    stroke="#dc5a5a"
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
                    stroke="#0f766e"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                  <Line
                    type="monotone"
                    dataKey="p95LatencyMs"
                    stroke="#d97706"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                  <Line
                    type="monotone"
                    dataKey="p99LatencyMs"
                    stroke="#dc5a5a"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                </>
              ) : null}
              {metric === 'tokens' ? (
                <>
                  <Bar dataKey="inputTokens" stackId="tokens" fill="#64748b" maxBarSize={28} />
                  <Bar
                    dataKey="outputTokens"
                    stackId="tokens"
                    fill="var(--blue)"
                    maxBarSize={28}
                    radius={[3, 3, 0, 0]}
                  />
                </>
              ) : null}
              {metric === 'cost' ? (
                <Bar dataKey="costUsd" fill="#7c3aed" maxBarSize={28} radius={[3, 3, 0, 0]} />
              ) : null}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="analytics-empty performance-empty">该时段没有调用。</div>
      )}
    </section>
  );
}
