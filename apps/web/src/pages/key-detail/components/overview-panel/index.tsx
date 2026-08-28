import { CircleDollarSign, Gauge, Timer, Zap } from 'lucide-react';

import { Button, Skeleton } from '../../../../components/ui';
import type {
  KeyAnalyticsRange,
  KeyAnalyticsResponse,
  KeyAnalyticsSummary,
} from '../../../../types';
import {
  allModelsValue,
  decimal,
  formatFullDate,
  integer,
  money,
  rangeLabels,
  successRate,
  type AnalyticsModelOption,
} from '../../key-detail-model';
import './overview-panel.css';

interface OverviewPanelProps {
  apiKey: KeyAnalyticsResponse['key'];
  range: KeyAnalyticsRange;
  modelOptions: AnalyticsModelOption[];
  selectedModel: string;
  onSelectedModelChange: (identity: string) => void;
  summary: KeyAnalyticsSummary | undefined;
  loading: boolean;
  error: string;
  onRetry: () => void;
}

export function OverviewPanel({
  apiKey,
  range,
  modelOptions,
  selectedModel,
  onSelectedModelChange,
  summary,
  loading,
  error,
  onRetry,
}: OverviewPanelProps) {
  return (
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
            <dd>{formatFullDate(apiKey.createdAt)}</dd>
          </div>
          <div>
            <dt>最近调用</dt>
            <dd>{apiKey.lastUsedAt ? formatFullDate(apiKey.lastUsedAt) : '—'}</dd>
          </div>
          <div>
            <dt>到期时间</dt>
            <dd>{apiKey.expiresAt ? formatFullDate(apiKey.expiresAt) : '永不过期'}</dd>
          </div>
          <div>
            <dt>上游</dt>
            <dd>{apiKey.providerName ?? '自动路由'}</dd>
          </div>
          <div>
            <dt>RPM</dt>
            <dd>{apiKey.rpmLimit === 0 ? '无限制' : integer.format(apiKey.rpmLimit)}</dd>
          </div>
          <div>
            <dt>预算</dt>
            <dd>{apiKey.budgetUsd === null ? '无限制' : money.format(apiKey.budgetUsd)}</dd>
          </div>
          <div>
            <dt>累计使用</dt>
            <dd>{money.format(apiKey.spendUsd)}</dd>
          </div>
        </dl>
      </section>

      <div className="overview-section-heading">
        <h2>使用概览</h2>
        <div className="overview-section-controls">
          <select
            className="input overview-model-filter"
            value={selectedModel}
            disabled={!modelOptions.length}
            onChange={(event) => onSelectedModelChange(event.target.value)}
            aria-label="使用概览模型筛选"
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
          <span>{rangeLabels[range]}</span>
        </div>
      </div>
      {error ? (
        <section className="panel overview-model-error">
          <span>{error}</span>
          <Button variant="secondary" onClick={onRetry}>
            重试
          </Button>
        </section>
      ) : loading || !summary ? (
        <Skeleton height={112} />
      ) : (
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
            <strong>{decimal.format(successRate(summary.calls, summary.successfulCalls))}%</strong>
            <small>{integer.format(summary.successfulCalls)} 次成功</small>
          </article>
        </section>
      )}
    </div>
  );
}
