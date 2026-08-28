import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Copy, ShieldCheck } from 'lucide-react';

import { api, ApiError } from '../../api';
import { copyText } from '../../clipboard';
import type { UsageCallDetailResponse } from '../../types';
import { Skeleton } from '../ui';
import { requestJavaScript, requestJson } from './request-copy';
import './usage-log-detail-panel.css';

type DetailTab = 'client' | 'upstream' | 'response' | 'error';
type RequestScope = 'client' | 'upstream';
type RequestFormat = 'curl' | 'javascript';
type CopyAction =
  'detail' | `${RequestScope}-json` | `${RequestScope}-${RequestFormat}-${'redacted' | 'key'}`;

const tabLabels: Record<DetailTab, string> = {
  client: '客户端请求',
  upstream: '上游请求',
  response: '上游返回',
  error: '错误',
};

function json(value: unknown): string {
  return value === null || value === undefined ? '暂无数据' : JSON.stringify(value, null, 2);
}

function SplitCopyButton({
  format,
  redactedAction,
  keyAction,
  copyResult,
  loading,
  onRedacted,
  onPreserveKey,
}: {
  format: 'CURL' | 'JS 请求';
  redactedAction: CopyAction;
  keyAction: CopyAction;
  copyResult: { action: CopyAction; succeeded: boolean } | undefined;
  loading: boolean;
  onRedacted: () => void;
  onPreserveKey: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const ownResult =
    copyResult?.action === redactedAction || copyResult?.action === keyAction
      ? copyResult
      : undefined;
  const label = loading
    ? '正在生成…'
    : ownResult
      ? ownResult.succeeded
        ? '已复制'
        : '复制失败'
      : `复制 ${format}（脱敏）`;

  return (
    <div className="usage-detail-copy-menu" ref={menuRef}>
      <div className="usage-detail-split-copy">
        <button
          className="usage-detail-copy usage-detail-copy-main"
          onClick={onRedacted}
          aria-label={`复制 ${format}（脱敏）`}
          disabled={loading}
        >
          {ownResult?.succeeded ? <Check size={14} /> : <Copy size={14} />}
          {label}
        </button>
        <button
          className="usage-detail-copy-toggle"
          onClick={() => setOpen((value) => !value)}
          aria-label={`选择 ${format} 复制方式`}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={loading}
        >
          <ChevronDown size={13} />
        </button>
      </div>
      {open ? (
        <div className="usage-detail-copy-dropdown" role="menu">
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onRedacted();
            }}
          >
            <span>复制 {format}（脱敏）</span>
            <small>默认</small>
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onPreserveKey();
            }}
          >
            复制 {format}（保留 Key）
          </button>
        </div>
      ) : null}
    </div>
  );
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
  const [preserveKeyLoading, setPreserveKeyLoading] = useState<CopyAction>();

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
    if (tab === 'client') return requestJson(detail.clientRequest);
    if (tab === 'upstream') return json(detail.upstreamRequest);
    if (tab === 'response') return json(detail.upstreamResponse);
    return json(detail.error);
  }, [response, tab]);

  useEffect(() => {
    if (!copyResult) return;
    const timer = window.setTimeout(() => setCopyResult(undefined), 3_000);
    return () => window.clearTimeout(timer);
  }, [copyResult]);

  const copy = (action: CopyAction, value: string) => {
    setCopyError('');
    void copyText(value).then((succeeded) => setCopyResult({ action, succeeded }));
  };

  const copyWithKey = async (scope: RequestScope, format: RequestFormat) => {
    const action = `${scope}-${format}-key` as CopyAction;
    setCopyError('');
    setCopyResult(undefined);
    setPreserveKeyLoading(action);
    try {
      const result = await api<{ content: string }>(
        `/api/admin/usage/logs/${usageLogId}/detail/copy-with-key?scope=${scope}&format=${format}`,
      );
      const succeeded = await copyText(result.content);
      setCopyResult({ action, succeeded });
      if (!succeeded) setCopyError('复制失败，请重试。');
    } catch (caught: unknown) {
      setCopyResult({ action, succeeded: false });
      setCopyError(caught instanceof ApiError ? caught.message : '保留 Key 的请求代码生成失败。');
    } finally {
      setPreserveKeyLoading(undefined);
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
        className={`usage-detail-code-wrap${tab === 'client' || tab === 'upstream' ? ' has-multiple-copy-actions' : ''}`}
      >
        <div className="usage-detail-copy-actions" aria-live="polite">
          {tab === 'client' || tab === 'upstream' ? (
            <>
              <button
                className="usage-detail-copy"
                onClick={() => copy(`${tab}-json`, content)}
                aria-label={`复制${tab === 'client' ? '客户端' : '上游'}请求 JSON`}
              >
                {copyResult?.action === `${tab}-json` && copyResult.succeeded ? (
                  <Check size={14} />
                ) : (
                  <Copy size={14} />
                )}
                {copyLabel(`${tab}-json`, '复制 JSON')}
              </button>
              <SplitCopyButton
                key={`${tab}-curl`}
                format="CURL"
                redactedAction={`${tab}-curl-redacted`}
                keyAction={`${tab}-curl-key`}
                copyResult={copyResult}
                loading={preserveKeyLoading === `${tab}-curl-key`}
                onRedacted={() =>
                  copy(
                    `${tab}-curl-redacted`,
                    tab === 'client' ? detail.gatewayCurl : (detail.upstreamCurl ?? '暂无数据'),
                  )
                }
                onPreserveKey={() => void copyWithKey(tab, 'curl')}
              />
              <SplitCopyButton
                key={`${tab}-javascript`}
                format="JS 请求"
                redactedAction={`${tab}-javascript-redacted`}
                keyAction={`${tab}-javascript-key`}
                copyResult={copyResult}
                loading={preserveKeyLoading === `${tab}-javascript-key`}
                onRedacted={() =>
                  copy(
                    `${tab}-javascript-redacted`,
                    requestJavaScript(
                      tab === 'client' ? detail.clientRequest : detail.upstreamRequest,
                      tab === 'client' ? '<ROUTER_API_KEY>' : '<UPSTREAM_CREDENTIAL>',
                    ),
                  )
                }
                onPreserveKey={() => void copyWithKey(tab, 'javascript')}
              />
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
