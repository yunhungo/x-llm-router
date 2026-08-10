import { useEffect, useState } from 'react';
import { RefreshCcw } from 'lucide-react';
import { Link } from 'react-router-dom';

import { api } from '../api';
import { Badge, Button, PageHeader, Skeleton } from '../components/ui';
import type { UsageLog } from '../types';

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 4,
  maximumFractionDigits: 8,
});
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

function tokensPerSecond(log: UsageLog) {
  const generationMs = log.latencyMs - (log.timeToFirstTokenMs ?? 0);
  if (log.outputTokens <= 0 || generationMs <= 0) return null;
  return (log.outputTokens * 1_000) / generationMs;
}

export function UsagePage() {
  const [logs, setLogs] = useState<UsageLog[]>();
  const [refreshing, setRefreshing] = useState(false);
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
                </tr>
              </thead>
              <tbody>
                {logs.length ? (
                  logs.map((log) => (
                    <tr key={log.id}>
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
                      </td>
                      <td>
                        {log.apiKeyId && log.apiKeyName ? (
                          <Link className="usage-key-link" to={`/keys/${log.apiKeyId}`}>
                            {log.apiKeyName}
                          </Link>
                        ) : (
                          'Deleted key'
                        )}
                      </td>
                      <td>
                        {log.totalTokens.toLocaleString()}
                        <small>
                          {log.inputTokens} in · {log.cachedInputTokens} cached · {log.outputTokens}{' '}
                          out
                        </small>
                      </td>
                      <td>
                        {log.latencyMs.toLocaleString()} ms
                        {log.timeToFirstTokenMs ? (
                          <small>
                            TTFT {log.timeToFirstTokenMs} ms · TPS{' '}
                            {tokensPerSecond(log) === null
                              ? '—'
                              : decimal.format(tokensPerSecond(log) ?? 0)}
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
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={8} className="table-empty">
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
