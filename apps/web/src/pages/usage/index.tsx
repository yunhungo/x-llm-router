import { useCallback, useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, RefreshCcw } from 'lucide-react';
import { Link } from 'react-router-dom';

import { api, ApiError } from '../../api';
import { UsageLogDetailPanel } from '../../components/usage-log-detail-panel';
import { isUsageLogActive, UsageLogStatusBadge } from '../../components/usage-log-status';
import { Button, PageHeader, Skeleton } from '../../components/ui';
import type { UsageLog, UsageLogsPage } from '../../types';
import {
  appendUniqueUsageLogs,
  calculateUsageLogBatchSize,
  ESTIMATED_USAGE_LOG_ROW_HEIGHT,
  shouldLoadMoreUsageLogs,
} from './usage-pagination';
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
  const [logs, setLogs] = useState<UsageLog[]>();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState('');
  const [hasMore, setHasMore] = useState(true);
  const [expandedId, setExpandedId] = useState<string>();
  const loadController = useRef<AbortController | undefined>(undefined);
  const nextCursor = useRef<string | null>(null);
  const hasMoreRef = useRef(true);
  const tableContainerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (mode: 'reset' | 'append' = 'reset') => {
    if (mode === 'append' && (!hasMoreRef.current || loadController.current)) return;
    if (mode === 'reset') loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    if (mode === 'reset') {
      setRefreshing(true);
      setLoadingMore(false);
      setRefreshError('');
      setLoadMoreError('');
    } else {
      setLoadingMore(true);
      setLoadMoreError('');
    }
    try {
      const viewportHeight = tableContainerRef.current?.clientHeight ?? window.innerHeight;
      const search = new URLSearchParams({
        limit: String(calculateUsageLogBatchSize(viewportHeight)),
      });
      if (mode === 'append' && nextCursor.current) search.set('cursor', nextCursor.current);
      const response = await api<UsageLogsPage>(`/api/admin/usage/logs?${search}`, {
        signal: controller.signal,
      });
      const canLoadMore = response.hasMore && Boolean(response.nextCursor);
      nextCursor.current = response.nextCursor;
      hasMoreRef.current = canLoadMore;
      setHasMore(canLoadMore);
      if (mode === 'reset') {
        setLogs(response.logs);
        setExpandedId(undefined);
        if (tableContainerRef.current) tableContainerRef.current.scrollTop = 0;
      } else {
        setLogs((current) => appendUniqueUsageLogs(current ?? [], response.logs));
      }
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
        const message = caught instanceof ApiError ? caught.message : '调用记录加载失败。';
        if (mode === 'reset') setRefreshError(message);
        else setLoadMoreError(message);
      }
    } finally {
      if (loadController.current === controller) {
        loadController.current = undefined;
        if (mode === 'reset') setRefreshing(false);
        else setLoadingMore(false);
      }
    }
  }, []);

  const handleTableScroll = useCallback(() => {
    const container = tableContainerRef.current;
    if (!container || loadingMore || loadMoreError || !hasMore) return;
    if (
      shouldLoadMoreUsageLogs({
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
        clientHeight: container.clientHeight,
      })
    ) {
      void load('append');
    }
  }, [hasMore, load, loadMoreError, loadingMore]);

  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    count: logs?.length ?? 0,
    getScrollElement: () => tableContainerRef.current,
    getItemKey: (index) => logs?.[index]?.id ?? index,
    estimateSize: (index) =>
      logs?.[index]?.id === expandedId ? 420 : ESTIMATED_USAGE_LOG_ROW_HEIGHT,
    measureElement: (element) => element.getBoundingClientRect().height,
    overscan: 8,
    useFlushSync: false,
  });

  useEffect(() => {
    void load('reset');
    return () => {
      loadController.current?.abort();
    };
  }, [load]);

  return (
    <div className="page-wrap">
      <PageHeader
        title="调用记录"
        action={
          <Button variant="secondary" loading={refreshing} onClick={() => void load('reset')}>
            <RefreshCcw size={14} /> 刷新
          </Button>
        }
      />
      {refreshError ? (
        <div className="usage-refresh-error" role="alert">
          {refreshError} 可点击“刷新”重试。
        </div>
      ) : null}
      {!logs ? (
        <Skeleton height={420} />
      ) : (
        <section className="panel flush-panel">
          <div
            ref={tableContainerRef}
            className="table-wrap usage-table"
            onScroll={handleTableScroll}
            aria-busy={refreshing || loadingMore}
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
                        <td>
                          {active ? (
                            <>
                              —<small>Usage pending</small>
                            </>
                          ) : (
                            <>
                              {log.totalTokens.toLocaleString()}
                              <small>
                                {log.inputTokens} in · {log.cachedInputTokens} cached ·{' '}
                                {log.outputTokens} out
                                {log.reasoningTokens === null
                                  ? ''
                                  : ` · ${log.reasoningTokens} reasoning`}
                              </small>
                            </>
                          )}
                        </td>
                        <td>
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
            {logs.length && (loadingMore || loadMoreError || !hasMore) ? (
              <div
                className={`usage-load-status${loadMoreError ? ' error' : ''}`}
                role={loadMoreError ? 'alert' : 'status'}
                aria-live={loadMoreError ? 'assertive' : 'polite'}
              >
                {loadingMore ? '正在加载下一批调用记录…' : null}
                {loadMoreError ? (
                  <>
                    <span>{loadMoreError}</span>
                    <Button variant="secondary" onClick={() => void load('append')}>
                      重试
                    </Button>
                  </>
                ) : null}
                {!loadingMore && !loadMoreError && !hasMore
                  ? `已加载全部 ${logs.length} 条调用记录。`
                  : null}
              </div>
            ) : null}
          </div>
        </section>
      )}
    </div>
  );
}
