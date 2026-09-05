/**
 * @created 2026-08-28
 * @description 展示 API Key 调用记录、性能指标及明细。
 * @author yunhungo
 */
import { UsageLogPerformance } from '@/components/UsageLogPerformance/UsageLogPerformance';

import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, X } from 'lucide-react';
import type { RefObject, UIEventHandler } from 'react';

import { UsageLogFilters } from '../../../../components/usage-log-filters';
import { UsageLogDetailPanel } from '../../../../components/usage-log-detail-panel';
import { UsageLogLoadStatus } from '../../../../components/usage-log-load-status';
import { isUsageLogActive, UsageLogStatusBadge } from '../../../../components/usage-log-status';
import { UsageLogTokenSummary } from '../../../../components/usage-log-token-summary';
import { Button, Skeleton } from '../../../../components/ui';
import type { UsageLogFiltersState } from '../../../../features/usage/usage-log-pagination';
import { ESTIMATED_USAGE_LOG_ROW_HEIGHT } from '../../../../features/usage/usage-log-pagination';
import type { KeyUsageLog } from '../../../../types';
import {
  endpointLabel,
  formatDate,
  integer,
  money,
  type LogDrilldown,
} from '../../key-detail-model';
import './logs-panel.scss';

interface LogsPanelProps {
  logs: KeyUsageLog[] | undefined;
  modelNames: string[];
  endpoints: string[];
  filters: UsageLogFiltersState;
  onFiltersChange: (filters: UsageLogFiltersState) => void;
  timeError: string;
  onResetFilters: () => void;
  drilldown: LogDrilldown | undefined;
  onClearDrilldown: () => void;
  loading: boolean;
  error: string;
  onRetry: () => void;
  loadingMore: boolean;
  loadMoreError: string;
  onRetryLoadMore: () => void;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onScroll: UIEventHandler<HTMLDivElement>;
  expandedLogId: string | undefined;
  onToggleExpandedLog: (id: string) => void;
}

export function LogsPanel({
  logs,
  modelNames,
  endpoints,
  filters,
  onFiltersChange,
  timeError,
  onResetFilters,
  drilldown,
  onClearDrilldown,
  loading,
  error,
  onRetry,
  loadingMore,
  loadMoreError,
  onRetryLoadMore,
  scrollContainerRef,
  onScroll,
  expandedLogId,
  onToggleExpandedLog,
}: LogsPanelProps) {
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    count: logs?.length ?? 0,
    getScrollElement: () => scrollContainerRef.current,
    getItemKey: (index) => logs?.[index]?.id ?? index,
    estimateSize: (index) =>
      logs?.[index]?.id === expandedLogId ? 420 : ESTIMATED_USAGE_LOG_ROW_HEIGHT,
    measureElement: (element) => element.getBoundingClientRect().height,
    overscan: 8,
    useFlushSync: false,
  });

  return (
    <div
      id="key-panel-logs"
      className="key-tab-panel"
      role="tabpanel"
      aria-labelledby="key-tab-logs"
    >
      <section className="panel flush-panel logs-panel" id="key-usage-logs">
        <UsageLogFilters
          filters={filters}
          models={modelNames}
          endpoints={endpoints}
          loadedCount={logs?.length ?? 0}
          timeError={timeError}
          onChange={onFiltersChange}
          onReset={onResetFilters}
        />
        {drilldown ? (
          <div className="drilldown-bar">
            <span>{drilldown.label}</span>
            <button type="button" onClick={onClearDrilldown}>
              <X size={13} /> 清除
            </button>
          </div>
        ) : null}
        {loading && logs ? <div className="log-query-progress">正在刷新调用记录…</div> : null}
        {error ? (
          <div className="log-query-error" role="alert">
            <span>{error}</span>
            <Button variant="secondary" onClick={onRetry}>
              重试
            </Button>
          </div>
        ) : null}
        {timeError ? (
          <div className="log-filter-placeholder">请修正时间范围后加载调用记录。</div>
        ) : !logs ? (
          <div className="log-list-skeleton">
            <Skeleton height={360} />
          </div>
        ) : (
          <div
            ref={scrollContainerRef}
            className="table-wrap usage-table key-detail-table"
            onScroll={onScroll}
            aria-busy={loading || loadingMore}
          >
            <table className="key-usage-virtual-table">
              <thead>
                <tr>
                  <th className="usage-expand-header" />
                  <th>状态</th>
                  <th>请求</th>
                  <th>模型</th>
                  <th>Token</th>
                  <th>输出性能</th>
                  <th>延迟</th>
                  <th>成本</th>
                  <th>时间</th>
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
                        className={`usage-log-row key-usage-virtual-row${active ? ' usage-log-row-active' : ''}`}
                        aria-expanded={active ? undefined : expandedLogId === log.id}
                        style={{ transform: `translateY(${virtualRow.start}px)` }}
                        onClick={() => {
                          if (!active) onToggleExpandedLog(log.id);
                        }}
                      >
                        <td className="usage-expand-cell">
                          {active ? null : (
                            <button
                              className="usage-expand-button"
                              onClick={(event) => {
                                event.stopPropagation();
                                onToggleExpandedLog(log.id);
                              }}
                              aria-label={
                                expandedLogId === log.id ? '收起调用明细' : '展开调用明细'
                              }
                            >
                              <ChevronDown size={15} />
                            </button>
                          )}
                        </td>
                        <td>
                          <UsageLogStatusBadge
                            callStatus={log.callStatus}
                            statusCode={log.statusCode}
                          />
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
                          {active ? (
                            '—'
                          ) : (
                            <UsageLogPerformance
                              tps={log.tps}
                              timeToFirstTokenMs={log.timeToFirstTokenMs}
                              timeToFirstVisibleTokenMs={log.timeToFirstVisibleTokenMs}
                            />
                          )}
                        </td>
                        <td>
                          {active
                            ? `${integer.format(
                                Math.max(Date.now() - new Date(log.createdAt).getTime(), 0),
                              )} ms`
                            : `${integer.format(log.latencyMs)} ms`}
                        </td>
                        <td>{active ? '—' : money.format(log.costUsd)}</td>
                        <td>{formatDate(log.createdAt)}</td>
                        {expandedLogId === log.id ? (
                          <td
                            className="key-usage-virtual-detail-cell"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <UsageLogDetailPanel usageLogId={log.id} />
                          </td>
                        ) : null}
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={9} className="table-empty">
                      暂无匹配记录
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <UsageLogLoadStatus
              loading={loadingMore}
              error={loadMoreError}
              onRetry={onRetryLoadMore}
            />
          </div>
        )}
      </section>
    </div>
  );
}
