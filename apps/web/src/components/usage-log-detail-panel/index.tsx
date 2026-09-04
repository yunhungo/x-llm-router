import { useEffect, useMemo, useState } from 'react';
import { Copy, ShieldCheck } from 'lucide-react';

import { api, ApiError } from '../../api';
import { copyText } from '../../clipboard';
import type { UsageCallDetailResponse } from '../../types';
import { JsonCodeViewer } from '../json-code-viewer';
import { SplitCopyButton, type CopyMode } from '../split-copy-button';
import { Skeleton, Toast } from '../ui';
import { requestJavaScript, requestJson } from './request-copy';
import './usage-log-detail-panel.css';

type DetailTab = 'client' | 'upstream' | 'response' | 'error';
type RequestScope = 'client' | 'upstream';
type RequestFormat = 'curl' | 'javascript';

const tabLabels: Record<DetailTab, string> = {
  client: '客户端请求',
  upstream: '上游请求',
  response: '上游返回',
  error: '错误',
};

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
  const [copySuccess, setCopySuccess] = useState<{ message: string }>();
  const [copyModes, setCopyModes] = useState<Record<RequestFormat, CopyMode>>({
    curl: 'redacted',
    javascript: 'redacted',
  });
  const [copyError, setCopyError] = useState('');
  const [preserveKeyLoading, setPreserveKeyLoading] = useState<RequestFormat>();

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
    if (tab === 'upstream') return requestJson(detail.upstreamRequest);
    if (tab === 'response') return requestJson(detail.upstreamResponse);
    return requestJson(detail.error);
  }, [response, tab]);

  const copy = async (value: string, label: string) => {
    setCopyError('');
    setCopySuccess(undefined);
    const succeeded = await copyText(value);
    if (succeeded) setCopySuccess({ message: `已复制${label}` });
    else setCopyError('复制失败，请重试。');
  };

  const copyRequest = async (scope: RequestScope, format: RequestFormat) => {
    const mode = copyModes[format];
    const label = `${format === 'curl' ? 'CURL' : 'JS 请求'}（${mode === 'key' ? '保留 Key' : '脱敏'}）`;
    if (mode === 'redacted') {
      const detail = response?.detail;
      if (!detail) return;
      const value =
        format === 'curl'
          ? scope === 'client'
            ? detail.gatewayCurl
            : (detail.upstreamCurl ?? '暂无数据')
          : requestJavaScript(
              scope === 'client' ? detail.clientRequest : detail.upstreamRequest,
              scope === 'client' ? '<ROUTER_API_KEY>' : '<UPSTREAM_CREDENTIAL>',
            );
      await copy(value, label);
      return;
    }

    setCopyError('');
    setCopySuccess(undefined);
    setPreserveKeyLoading(format);
    try {
      const result = await api<{ content: string }>(
        `/api/admin/usage/logs/${usageLogId}/detail/copy-with-key?scope=${scope}&format=${format}`,
      );
      await copy(result.content, label);
    } catch (caught: unknown) {
      setCopyError(caught instanceof ApiError ? caught.message : '保留 Key 的请求代码生成失败。');
    } finally {
      setPreserveKeyLoading(undefined);
    }
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
                setCopySuccess(undefined);
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
      <JsonCodeViewer
        key={`${usageLogId}-${tab}`}
        value={content}
        actions={
          <>
            <button
              type="button"
              className="usage-detail-copy"
              onClick={() => void copy(content, 'JSON')}
              aria-label="复制 JSON"
            >
              <Copy size={14} />
              复制 JSON
            </button>
            {tab === 'client' || tab === 'upstream' ? (
              <>
                {(['curl', 'javascript'] as const).map((format) => (
                  <SplitCopyButton
                    key={format}
                    format={format === 'curl' ? 'CURL' : 'JS 请求'}
                    mode={copyModes[format]}
                    loading={preserveKeyLoading === format}
                    disabled={preserveKeyLoading !== undefined}
                    onModeChange={(mode) => {
                      setCopyModes((current) => ({ ...current, [format]: mode }));
                      setCopySuccess(undefined);
                      setCopyError('');
                    }}
                    onCopy={() => void copyRequest(tab, format)}
                  />
                ))}
              </>
            ) : null}
          </>
        }
        feedback={
          <>
            {copySuccess ? (
              <Toast tone="success" onDismiss={() => setCopySuccess(undefined)}>
                {copySuccess.message}
              </Toast>
            ) : null}
            {copyError ? (
              <div className="usage-detail-copy-error" role="alert">
                {copyError}
              </div>
            ) : null}
          </>
        }
      />
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
