import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, ShieldCheck } from 'lucide-react';

import { api, ApiError } from '../api';
import { Skeleton } from '../components/ui';
import type { UsageCallDetailResponse } from '../types';
import './usage-log-detail.css';

type DetailTab = 'curl' | 'client' | 'upstream' | 'response' | 'error';

const tabLabels: Record<DetailTab, string> = {
  curl: 'Curl',
  client: '客户端请求',
  upstream: '上游请求',
  response: '上游返回',
  error: '错误',
};

function json(value: unknown): string {
  return value === null || value === undefined ? '暂无数据' : JSON.stringify(value, null, 2);
}

export function UsageLogDetailPanel({ usageLogId }: { usageLogId: string }) {
  const [response, setResponse] = useState<UsageCallDetailResponse>();
  const [error, setError] = useState('');
  const [tab, setTab] = useState<DetailTab>('upstream');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    void api<UsageCallDetailResponse>(`/api/admin/usage/logs/${usageLogId}/detail`)
      .then((result) => {
        if (active) setResponse(result);
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof ApiError ? caught.message : '调用明细加载失败。');
      });
    return () => {
      active = false;
    };
  }, [usageLogId]);

  const tabs = useMemo<DetailTab[]>(
    () => [
      'curl',
      'client',
      'upstream',
      'response',
      ...(response?.detail?.error ? ['error' as const] : []),
    ],
    [response],
  );
  const content = useMemo(() => {
    const detail = response?.detail;
    if (!detail) return '';
    if (tab === 'curl') {
      return [
        '# Gateway\n' + detail.gatewayCurl,
        detail.upstreamCurl
          ? '# Upstream（凭据已脱敏）\n' + detail.upstreamCurl
          : '# Upstream\n请求未到达上游。',
      ].join('\n\n');
    }
    if (tab === 'client') return json(detail.clientRequest);
    if (tab === 'upstream') return json(detail.upstreamRequest);
    if (tab === 'response') return json(detail.upstreamResponse);
    return json(detail.error);
  }, [response, tab]);

  if (error) return <div className="usage-detail-empty error">{error}</div>;
  if (!response) return <Skeleton height={210} />;
  if (!response.detail) {
    return (
      <div className="usage-detail-empty">
        {response.expired ? '调用明细已超过 30 天并过期。' : '该历史调用未采集请求与返回明细。'}
      </div>
    );
  }

  return (
    <div className="usage-detail-panel">
      <div className="usage-detail-topbar">
        <div className="usage-detail-tabs" role="tablist">
          {tabs.map((value) => (
            <button
              key={value}
              role="tab"
              aria-selected={tab === value}
              className={tab === value ? 'active' : ''}
              onClick={() => {
                setTab(value);
                setCopied(false);
              }}
            >
              {tabLabels[value]}
            </button>
          ))}
        </div>
        <div className="usage-detail-retention">
          <ShieldCheck size={13} /> 凭据已脱敏 · 保留至{' '}
          {new Date(response.detail.expiresAt).toLocaleDateString('zh-CN')}
        </div>
      </div>
      <div className="usage-detail-code-wrap">
        <button
          className="usage-detail-copy"
          onClick={() => {
            void navigator.clipboard.writeText(content);
            setCopied(true);
          }}
          aria-label="复制明细"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? '已复制' : '复制'}
        </button>
        <pre>
          <code>{content}</code>
        </pre>
      </div>
      <div className="usage-detail-models">
        <span>
          请求模型 <code>{response.detail.requestedModel}</code>
        </span>
        <span>
          上游模型 <code>{response.detail.upstreamModel}</code>
        </span>
      </div>
    </div>
  );
}
