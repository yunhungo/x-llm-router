import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Copy, ShieldCheck } from 'lucide-react';

import { api, ApiError } from '../../api';
import { copyText } from '../../clipboard';
import type { UsageCallDetailResponse } from '../../types';
import { Skeleton } from '../ui';
import { clientRequestJavaScript, clientRequestJson } from './request-copy';
import './usage-log-detail-panel.css';

type DetailTab = 'client' | 'upstream' | 'response' | 'error';
type CopyAction = 'detail' | 'json' | 'curl-redacted' | 'curl-key' | 'javascript';

const tabLabels: Record<DetailTab, string> = {
  client: '客户端请求',
  upstream: '上游请求',
  response: '上游返回',
  error: '错误',
};

function json(value: unknown): string {
  return value === null || value === undefined ? '暂无数据' : JSON.stringify(value, null, 2);
}

export function UsageLogDetailPanel({
  usageLogId,
  initialTab = 'upstream',
}: {
  usageLogId: string;
  initialTab?: DetailTab;
}) {
  const [response, setResponse] = useState<UsageCallDetailResponse>();
  const [error, setError] = useState('');
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [copyResult, setCopyResult] = useState<{
    action: CopyAction;
    succeeded: boolean;
  }>();
  const [copyError, setCopyError] = useState('');
  const [curlMenuOpen, setCurlMenuOpen] = useState(false);
  const [curlKeyLoading, setCurlKeyLoading] = useState(false);
  const curlMenuRef = useRef<HTMLDivElement>(null);

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
      'client',
      'upstream',
      'response',
      ...(response?.detail?.error ? ['error' as const] : []),
    ],
    [response],
  );
  useEffect(() => {
    if (!response?.detail) return;
    setTab(tabs.includes(initialTab) ? initialTab : (tabs[0] ?? 'upstream'));
  }, [initialTab, response, tabs, usageLogId]);
  const content = useMemo(() => {
    const detail = response?.detail;
    if (!detail) return '';
    if (tab === 'client') return clientRequestJson(detail.clientRequest);
    if (tab === 'upstream') return json(detail.upstreamRequest);
    if (tab === 'response') return json(detail.upstreamResponse);
    return json(detail.error);
  }, [response, tab]);

  useEffect(() => {
    if (!copyResult) return;
    const timer = window.setTimeout(() => setCopyResult(undefined), 3_000);
    return () => window.clearTimeout(timer);
  }, [copyResult]);

  useEffect(() => {
    if (!curlMenuOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!curlMenuRef.current?.contains(event.target as Node)) setCurlMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCurlMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [curlMenuOpen]);

  const copy = (action: CopyAction, value: string) => {
    setCopyError('');
    void copyText(value).then((succeeded) => setCopyResult({ action, succeeded }));
  };

  const copyCurlWithKey = async () => {
    setCurlMenuOpen(false);
    setCopyError('');
    setCopyResult(undefined);
    setCurlKeyLoading(true);
    try {
      const result = await api<{ curl: string }>(
        `/api/admin/usage/logs/${usageLogId}/detail/curl-with-key`,
      );
      const succeeded = await copyText(result.curl);
      setCopyResult({ action: 'curl-key', succeeded });
      if (!succeeded) setCopyError('复制失败，请重试。');
    } catch (caught: unknown) {
      setCopyResult({ action: 'curl-key', succeeded: false });
      setCopyError(caught instanceof ApiError ? caught.message : '保留 Key 的 CURL 生成失败。');
    } finally {
      setCurlKeyLoading(false);
    }
  };

  const copyLabel = (action: CopyAction, label: string) => {
    if (copyResult?.action !== action) return label;
    return copyResult.succeeded ? '已复制' : '复制失败';
  };

  if (error) return <div className="usage-detail-empty error">{error}</div>;
  if (!response) return <Skeleton height={210} />;
  if (!response.detail) {
    return (
      <div className="usage-detail-empty">
        {response.expired ? '调用明细已超过 30 天并过期。' : '该历史调用未采集请求与返回明细。'}
      </div>
    );
  }
  const detail = response.detail;

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
                setCopyResult(undefined);
                setCopyError('');
                setCurlMenuOpen(false);
              }}
            >
              {tabLabels[value]}
            </button>
          ))}
        </div>
        <div className="usage-detail-retention">
          <ShieldCheck size={13} /> 凭据已脱敏 · 保留至{' '}
          {new Date(detail.expiresAt).toLocaleDateString('zh-CN')}
        </div>
      </div>
      <div
        className={`usage-detail-code-wrap${tab === 'client' ? ' has-multiple-copy-actions' : ''}`}
      >
        <div className="usage-detail-copy-actions" aria-live="polite">
          {tab === 'client' ? (
            <>
              <button
                className="usage-detail-copy"
                onClick={() => copy('json', content)}
                aria-label="复制客户端请求 JSON"
              >
                {copyResult?.action === 'json' && copyResult.succeeded ? (
                  <Check size={14} />
                ) : (
                  <Copy size={14} />
                )}
                {copyLabel('json', '复制 JSON')}
              </button>
              <div className="usage-detail-copy-menu" ref={curlMenuRef}>
                <div className="usage-detail-split-copy">
                  <button
                    className="usage-detail-copy usage-detail-copy-main"
                    onClick={() => copy('curl-redacted', detail.gatewayCurl)}
                    aria-label="复制 CURL（脱敏）"
                    disabled={curlKeyLoading}
                  >
                    {(copyResult?.action === 'curl-redacted' ||
                      copyResult?.action === 'curl-key') &&
                    copyResult.succeeded ? (
                      <Check size={14} />
                    ) : (
                      <Copy size={14} />
                    )}
                    {curlKeyLoading
                      ? '正在生成…'
                      : copyResult &&
                    (copyResult.action === 'curl-redacted' || copyResult.action === 'curl-key')
                      ? copyResult.succeeded
                        ? '已复制'
                        : '复制失败'
                      : '复制 CURL（脱敏）'}
                  </button>
                  <button
                    className="usage-detail-copy-toggle"
                    onClick={() => setCurlMenuOpen((open) => !open)}
                    aria-label="选择 CURL 复制方式"
                    aria-haspopup="menu"
                    aria-expanded={curlMenuOpen}
                    disabled={curlKeyLoading}
                  >
                    <ChevronDown size={13} />
                  </button>
                </div>
                {curlMenuOpen ? (
                  <div className="usage-detail-copy-dropdown" role="menu">
                    <button
                      role="menuitem"
                      onClick={() => {
                        setCurlMenuOpen(false);
                        copy('curl-redacted', detail.gatewayCurl);
                      }}
                    >
                      <span>复制 CURL（脱敏）</span>
                      <small>默认</small>
                    </button>
                    <button role="menuitem" onClick={() => void copyCurlWithKey()}>
                      复制 CURL（保留 Key）
                    </button>
                  </div>
                ) : null}
              </div>
              <button
                className="usage-detail-copy"
                onClick={() =>
                  copy('javascript', clientRequestJavaScript(detail.clientRequest))
                }
                aria-label="复制带 API token 的 JS 请求"
              >
                {copyResult?.action === 'javascript' && copyResult.succeeded ? (
                  <Check size={14} />
                ) : (
                  <Copy size={14} />
                )}
                {copyLabel('javascript', '复制 JS 请求')}
              </button>
            </>
          ) : (
            <button
              className="usage-detail-copy"
              onClick={() => copy('detail', content)}
              aria-label="复制明细"
            >
              {copyResult?.action === 'detail' && copyResult.succeeded ? (
                <Check size={14} />
              ) : (
                <Copy size={14} />
              )}
              {copyLabel('detail', '复制')}
            </button>
          )}
        </div>
        {copyError ? (
          <div className="usage-detail-copy-error" role="alert">
            {copyError}
          </div>
        ) : null}
        <pre>
          <code>{content}</code>
        </pre>
      </div>
      <div className="usage-detail-models">
        <span>
          请求模型 <code>{detail.requestedModel}</code>
        </span>
        <span>
          上游模型 <code>{detail.upstreamModel}</code>
        </span>
      </div>
    </div>
  );
}
