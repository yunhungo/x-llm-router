import { useCallback, useEffect, useRef, useState } from 'react';

import { api, ApiError } from '../../api';
import type { UsageLog, UsageLogsPage } from '../../types';
import {
  appendUniqueUsageLogs,
  calculateUsageLogBatchSize,
  shouldLoadMoreUsageLogs,
} from './usage-log-pagination';

const emptyFacets = { models: [] as string[], endpoints: [] as string[] };

export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}

export function useUsageLogPagination<TLog extends Pick<UsageLog, 'id'>>({
  query,
  enabled = true,
}: {
  query: string;
  enabled?: boolean;
}) {
  const [logs, setLogs] = useState<TLog[]>();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState('');
  const [hasMore, setHasMore] = useState(true);
  const [facets, setFacets] = useState(emptyFacets);
  const loadController = useRef<AbortController | undefined>(undefined);
  const nextCursor = useRef<string | null>(null);
  const hasMoreRef = useRef(true);
  const containerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (mode: 'reset' | 'append' = 'reset') => {
      if (!enabled) return;
      if (mode === 'append' && (!hasMoreRef.current || loadController.current)) return;
      if (mode === 'reset') loadController.current?.abort();
      const controller = new AbortController();
      loadController.current = controller;
      if (mode === 'reset') {
        setRefreshing(true);
        setLoadingMore(false);
        setError('');
        setLoadMoreError('');
      } else {
        setLoadingMore(true);
        setLoadMoreError('');
      }
      try {
        const viewportHeight = containerRef.current?.clientHeight ?? window.innerHeight;
        const search = new URLSearchParams(query);
        search.set('limit', String(calculateUsageLogBatchSize(viewportHeight)));
        if (mode === 'append' && nextCursor.current) search.set('cursor', nextCursor.current);
        const response = await api<UsageLogsPage<TLog>>(`/api/admin/usage/logs?${search}`, {
          signal: controller.signal,
        });
        const canLoadMore = response.hasMore && Boolean(response.nextCursor);
        nextCursor.current = response.nextCursor;
        hasMoreRef.current = canLoadMore;
        setHasMore(canLoadMore);
        if (response.facets) setFacets(response.facets);
        if (mode === 'reset') {
          setLogs(response.logs);
          if (containerRef.current) containerRef.current.scrollTop = 0;
        } else {
          setLogs((current) => appendUniqueUsageLogs(current ?? [], response.logs));
        }
      } catch (caught) {
        if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
          const message = caught instanceof ApiError ? caught.message : '调用记录加载失败。';
          if (mode === 'reset') setError(message);
          else setLoadMoreError(message);
        }
      } finally {
        if (loadController.current === controller) {
          loadController.current = undefined;
          if (mode === 'reset') setRefreshing(false);
          else setLoadingMore(false);
        }
      }
    },
    [enabled, query],
  );

  useEffect(() => {
    loadController.current?.abort();
    nextCursor.current = null;
    hasMoreRef.current = true;
    setHasMore(true);
    setLoadMoreError('');
    if (!enabled) {
      setLogs(undefined);
      setRefreshing(false);
      return;
    }
    setLogs(undefined);
    setFacets(emptyFacets);
    void load('reset');
    return () => loadController.current?.abort();
  }, [enabled, load]);

  const onScroll = useCallback(() => {
    const container = containerRef.current;
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

  return {
    logs,
    facets,
    refreshing,
    error,
    loadingMore,
    loadMoreError,
    hasMore,
    containerRef,
    onScroll,
    refresh: () => load('reset'),
    retryLoadMore: () => load('append'),
  };
}
