import { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  CircleCheck,
  Clock3,
  Coins,
  KeyRound,
  RadioTower,
  Sigma,
} from 'lucide-react';
import { Link } from 'react-router-dom';

import { api } from '../api';
import { Badge, PageHeader, Skeleton } from '../components/ui';
import type { ModelUsage, UsagePoint, UsageSummary } from '../types';

const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

function MiniChart({ points }: { points: UsagePoint[] }) {
  const max = Math.max(...points.map((point) => point.calls), 1);
  return (
    <div className="mini-chart" role="img" aria-label="最近 14 天调用趋势">
      {points.map((point) => (
        <div
          className="bar-column"
          key={point.bucket}
          title={`${point.bucket}: ${point.calls} calls`}
        >
          <div
            className="bar-value"
            style={{ height: `${Math.max(3, (point.calls / max) * 100)}%` }}
          />
          <span>{point.bucket.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

export function DashboardPage() {
  const [data, setData] = useState<{
    summary: UsageSummary;
    series: UsagePoint[];
    models: ModelUsage[];
  }>();
  useEffect(() => {
    void api<{ summary: UsageSummary; series: UsagePoint[]; models: ModelUsage[] }>(
      '/api/admin/usage/summary',
    ).then(setData);
  }, []);

  const successRate = data?.summary.calls
    ? (data.summary.successfulCalls / data.summary.calls) * 100
    : 100;
  return (
    <div className="page-wrap">
      <PageHeader
        eyebrow="Gateway overview"
        title="运行概览"
        description="近 24 小时"
        action={
          <div className="health-pill">
            <i /> Gateway healthy
          </div>
        }
      />

      {!data ? (
        <Skeleton height={146} />
      ) : (
        <section className="stat-grid">
          <article className="stat-card">
            <div className="stat-icon">
              <RadioTower size={17} />
            </div>
            <span>调用次数</span>
            <strong>{compact.format(data.summary.calls)}</strong>
            <small>过去 24 小时</small>
          </article>
          <article className="stat-card">
            <div className="stat-icon">
              <Sigma size={17} />
            </div>
            <span>Token 总量</span>
            <strong>{compact.format(data.summary.inputTokens + data.summary.outputTokens)}</strong>
            <small>
              {compact.format(data.summary.inputTokens)} 输入 /{' '}
              {compact.format(data.summary.outputTokens)} 输出
            </small>
          </article>
          <article className="stat-card">
            <div className="stat-icon">
              <Coins size={17} />
            </div>
            <span>估算成本</span>
            <strong>{money.format(data.summary.costUsd)}</strong>
            <small>按模型价格表计算</small>
          </article>
          <article className="stat-card">
            <div className="stat-icon">
              <Clock3 size={17} />
            </div>
            <span>平均延迟</span>
            <strong>{data.summary.averageLatencyMs.toLocaleString()} ms</strong>
            <small>
              <CircleCheck size={12} /> 成功率 {successRate.toFixed(1)}%
            </small>
          </article>
        </section>
      )}

      <section className="dashboard-grid">
        <article className="panel trend-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Traffic / 14 days</div>
              <h2>调用趋势</h2>
            </div>
            <Badge tone="blue">Daily</Badge>
          </div>
          {data ? <MiniChart points={data.series} /> : <Skeleton height={240} />}
        </article>
        <article className="panel quick-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Quick start</div>
              <h2>开始调用</h2>
            </div>
            <KeyRound size={18} />
          </div>
          <p>创建虚拟 API Key，然后把现有 OpenAI SDK 的 base URL 指向当前网关。</p>
          <div className="code-block">
            <span>curl</span>
            <code>
              POST /v1/responses
              <br />
              Authorization: Bearer xr_••••••••
            </code>
          </div>
          <Link className="inline-link" to="/keys">
            管理 API Keys <ArrowUpRight size={14} />
          </Link>
        </article>
      </section>

      <section className="panel model-panel">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">Model breakdown / 30 days</div>
            <h2>模型分布</h2>
          </div>
          <Link className="inline-link" to="/usage">
            查看全部 <ArrowUpRight size={14} />
          </Link>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>模型</th>
                <th>调用</th>
                <th>Token</th>
                <th>成本</th>
              </tr>
            </thead>
            <tbody>
              {data?.models.length ? (
                data.models.map((model) => (
                  <tr key={model.model}>
                    <td>
                      <code>{model.model}</code>
                    </td>
                    <td>{model.calls.toLocaleString()}</td>
                    <td>{compact.format(model.tokens)}</td>
                    <td>{money.format(model.costUsd)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="table-empty">
                    还没有调用数据。完成一次 API 请求后会显示在这里。
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
