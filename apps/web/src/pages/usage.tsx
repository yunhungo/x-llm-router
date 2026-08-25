import { Fragment, useEffect, useState } from 'react';
import { ChevronDown, RefreshCcw } from 'lucide-react';
import { Link } from 'react-router-dom';

import { api } from '../api';
import { Badge, Button, PageHeader, Skeleton } from '../components/ui';
import type { UsageLog } from '../types';
import { UsageLogDetailPanel } from './usage-log-detail';

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
  const [expandedId, setExpandedId] = useState<string>();
  const load = async () => {
    setRefreshing(true);
    try {
      const response = await api<{ logs: UsageLog[] }>('/api/admin/usage/logs?limit=100');
      setLogs(response.logs);
    } finally {
      setRefreshing(false);
    }
  };
  useEffect(() => void load(), []);

  return (
    <div className="page-wrap">
      <PageHeader
        title="调用记录"
        action={
          <Button variant="secondary" loading={refreshing} onClick={() => void load()}>
            <RefreshCcw size={14} /> 刷新
          </Button>
        }
      />
      {!logs ? (
        <Skeleton height={420} />
      ) : (
        <section className="panel flush-panel">
          <div className="table-wrap usage-table">
            <table>
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
              <tbody>
                {logs.length ? (
                  logs.map((log) => (
                    <Fragment key={log.id}>
                      <tr
                        className="usage-log-row"
                        aria-expanded={expandedId === log.id}
                        onClick={() =>
                          setExpandedId((current) => (current === log.id ? undefined : log.id))
                        }
                      >
                        <td>
                          <Badge tone={log.success ? 'success' : 'danger'}>{log.statusCode}</Badge>
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
                          {log.totalTokens.toLocaleString()}
                          <small>
                            {log.inputTokens} in · {log.cachedInputTokens} cached ·{' '}
                            {log.outputTokens} out
                            {log.reasoningTokens === null
                              ? ''
                              : ` · ${log.reasoningTokens} reasoning`}
                          </small>
                        </td>
                        <td>
                          {log.latencyMs.toLocaleString()} ms
                          {log.timeToFirstTokenMs !== null ? (
                            <small>
                              TPS{' '}
                              {tokensPerSecond(log) === null
                                ? '—'
                                : decimal.format(tokensPerSecond(log) ?? 0)}{' '}
                              · TTFT {log.timeToFirstTokenMs.toLocaleString()} ms
                            </small>
                          ) : null}
                        </td>
                        <td>{money.format(log.costUsd)}</td>
                        <td>
                          {new Date(log.createdAt).toLocaleString('zh-CN', {
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </td>
                        <td>
                          <button
                            className="usage-expand-button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setExpandedId((current) => (current === log.id ? undefined : log.id));
                            }}
                            aria-label={expandedId === log.id ? '收起调用明细' : '展开调用明细'}
                          >
                            <ChevronDown size={15} />
                          </button>
                        </td>
                      </tr>
                      {expandedId === log.id ? (
                        <tr className="usage-detail-row">
                          <td colSpan={9}>
                            <UsageLogDetailPanel usageLogId={log.id} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))
                ) : (
                  <tr>
                    <td colSpan={9} className="table-empty">
                      还没有调用记录。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
