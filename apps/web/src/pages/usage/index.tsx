import { useEffect, useMemo, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, RefreshCcw } from 'lucide-react';
import { Link } from 'react-router-dom';

import { UsageLogFilters } from '../../components/usage-log-filters';
import { UsageLogDetailPanel } from '../../components/usage-log-detail-panel';
import { UsageLogLoadStatus } from '../../components/usage-log-load-status';
import { isUsageLogActive, UsageLogStatusBadge } from '../../components/usage-log-status';
import { UsageLogTokenSummary } from '../../components/usage-log-token-summary';
import { Button, PageHeader, Skeleton } from '../../components/ui';
import {
  createDefaultUsageLogFilters,
  ESTIMATED_USAGE_LOG_ROW_HEIGHT,
  usageLogFilterSearchParams,
  usageLogTimeRangeError,
} from '../../features/usage/usage-log-pagination';
import {
  useDebouncedValue,
  useUsageLogPagination,
} from '../../features/usage/use-usage-log-pagination';
import type { UsageLog } from '../../types';
import './usage.css';

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 4,
  maximumFractionDigits: 8,
});
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

function tokensPerSecond(log: UsageLog) {
  if (log.timeToFirstTokenMs === null) return null;
  const generationMs = log.latencyMs - log.timeToFirstTokenMs;
  if (log.outputTokens <= 0 || generationMs <= 0) return null;
  return (log.outputTokens * 1_000) / generationMs;
}

export function UsagePage() {
  const [filters, setFilters] = useState(createDefaultUsageLogFilters);
  const [expandedId, setExpandedId] = useState<string>();
  const debouncedSearch = useDebouncedValue(filters.search);
  const timeError = usageLogTimeRangeError(filters);
  const query = useMemo(
    () =>
      timeError
        ? ''
        : usageLogFilterSearchParams({ ...filters, search: debouncedSearch }).toString(),
    [debouncedSearch, filters, timeError],
  );
  const pagination = useUsageLogPagination<UsageLog>({ query, enabled: !timeError });
  const logs = pagination.logs;

  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    count: logs?.length ?? 0,
    getScrollElement: () => pagination.containerRef.current,
    getItemKey: (index) => logs?.[index]?.id ?? index,
    estimateSize: (index) =>
      logs?.[index]?.id === expandedId ? 420 : ESTIMATED_USAGE_LOG_ROW_HEIGHT,
    measureElement: (element) => element.getBoundingClientRect().height,
    overscan: 8,
    useFlushSync: false,
  });

  useEffect(() => setExpandedId(undefined), [query]);

  return (
    <div className="page-wrap">
      <PageHeader
        title="调用记录"
        action={
          <Button
            variant="secondary"
            loading={pagination.refreshing}
            disabled={Boolean(timeError)}
            onClick={() => void pagination.refresh()}
          >
            <RefreshCcw size={14} /> 刷新
          </Button>
        }
      />
      {pagination.error ? (
        <div className="usage-refresh-error" role="alert">
          {pagination.error} 可点击“刷新”重试。
        </div>
      ) : null}
      <section className="panel flush-panel">
        <UsageLogFilters
          filters={filters}
          models={pagination.facets.models}
          endpoints={pagination.facets.endpoints}
          loadedCount={logs?.length ?? 0}
          timeError={timeError}
          onChange={setFilters}
          onReset={() => setFilters(createDefaultUsageLogFilters())}
        />
        {timeError ? (
          <div className="usage-filter-placeholder">请修正时间范围后加载调用记录。</div>
        ) : !logs ? (
          <div className="usage-list-skeleton">
            <Skeleton height={360} />
          </div>
        ) : (
          <div
            ref={pagination.containerRef}
            className="table-wrap usage-table"
            onScroll={pagination.onScroll}
            aria-busy={pagination.refreshing || pagination.loadingMore}
          >
            <table className="usage-virtual-table">
              <thead>
                <tr>
                  <th>状态</th>
                  <th>请求</th>
                  <th>模型</th>
                  <th>API Key</th>
                  <th>Token</th>
                  <th>延迟</th>
                  <th>成本</th>
                  <th>时间</th>
                  <th />
                </tr>
              </thead>
              <tbody
                style={logs.length ? { height: `${rowVirtualizer.getTotalSize()}px` } : undefined}
              >
                {logs.length ? (
                  rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const log = logs[virtualRow.index]!;
                    const active = isUsageLogActive(log.callStatus);
                    return (
                      <tr
                        key={log.id}
                        ref={(element) => rowVirtualizer.measureElement(element)}
                        data-index={virtualRow.index}
                        className={`usage-log-row usage-virtual-row${active ? ' usage-log-row-active' : ''}`}
                        aria-expanded={active ? undefined : expandedId === log.id}
                        style={{ transform: `translateY(${virtualRow.start}px)` }}
                        onClick={() => {
                          if (!active) {
                            setExpandedId((current) => (current === log.id ? undefined : log.id));
                          }
                        }}
                      >
                        <td>
                          <UsageLogStatusBadge
                            callStatus={log.callStatus}
                            statusCode={log.statusCode}
                          />
                        </td>
                        <td>
                          <div className="stack-cell">
                            <code>
                              {log.endpoint === 'responses' ? '/responses' : '/chat/completions'}
                            </code>
                            <span title={log.requestId}>{log.requestId.slice(0, 14)}…</span>
                          </div>
                        </td>
                        <td>
                          <code>{log.model}</code>
                          {log.requestedModel !== log.model ? (
                            <small>请求 {log.requestedModel}</small>
                          ) : null}
                        </td>
                        <td>
                          {log.apiKeyId && log.apiKeyName ? (
                            <Link
                              className="usage-key-link"
                              to={`/keys/${log.apiKeyId}`}
                              onClick={(event) => event.stopPropagation()}
                            >
                              {log.apiKeyName}
                            </Link>
                          ) : (
                            'Deleted key'
                          )}
                        </td>
                        <td className="usage-token-cell">
                          {active ? (
                            <>
                              —<small>Usage pending</small>
                            </>
                          ) : (
                            <UsageLogTokenSummary {...log} />
                          )}
                        </td>
                        <td className="usage-performance-cell">
                          {active
                            ? `${Math.max(Date.now() - new Date(log.createdAt).getTime(), 0).toLocaleString()} ms`
                            : `${log.latencyMs.toLocaleString()} ms`}
                          {active ? (
                            <small>Elapsed</small>
                          ) : log.timeToFirstTokenMs !== null ? (
                            <small>
                              TPS{' '}
                              {tokensPerSecond(log) === null
                                ? '—'
                                : decimal.format(tokensPerSecond(log) ?? 0)}{' '}
                              · TTFT {log.timeToFirstTokenMs.toLocaleString()} ms
                            </small>
                          ) : null}
                        </td>
                        <td>{active ? '—' : money.format(log.costUsd)}</td>
                        <td>
                          {new Date(log.createdAt).toLocaleString('zh-CN', {
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </td>
                        <td>
                          {active ? null : (
                            <button
                              className="usage-expand-button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setExpandedId((current) =>
                                  current === log.id ? undefined : log.id,
                                );
                              }}
                              aria-label={expandedId === log.id ? '收起调用明细' : '展开调用明细'}
                            >
                              <ChevronDown size={15} />
                            </button>
                          )}
                        </td>
                        {expandedId === log.id ? (
                          <td className="usage-virtual-detail-cell">
                            <UsageLogDetailPanel usageLogId={log.id} />
                          </td>
                        ) : null}
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={9} className="table-empty">
                      还没有调用记录。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <UsageLogLoadStatus
              loading={pagination.loadingMore}
              error={pagination.loadMoreError}
              onRetry={() => void pagination.retryLoadMore()}
            />
          </div>
        )}
      </section>
    </div>
  );
}
