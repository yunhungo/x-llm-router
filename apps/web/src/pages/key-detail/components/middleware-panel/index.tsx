import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Check, Save } from 'lucide-react';

import { ApiError, api, jsonBody } from '../../../../api';
import { Button, Skeleton } from '../../../../components/ui';
import { formatFullDate } from '../../key-detail-model';
import './middleware-panel.css';

const MiddlewareCodeEditor = lazy(() => import('../../../../components/middleware-code-editor'));

interface KeyMiddlewareConfig {
  code: string;
  updatedAt: string | null;
}

export function MiddlewarePanel({ keyId }: { keyId: string }) {
  const [code, setCode] = useState('');
  const [savedCode, setSavedCode] = useState('');
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const loadRequest = useRef(0);
  const saveInFlight = useRef(false);

  useEffect(() => {
    const requestId = ++loadRequest.current;
    const controller = new AbortController();
    setCode('');
    setSavedCode('');
    setUpdatedAt(null);
    setSaved(false);
    setLoading(true);
    setError('');

    void api<KeyMiddlewareConfig>(`/api/admin/keys/${keyId}/middleware`, {
      signal: controller.signal,
    })
      .then((response) => {
        if (loadRequest.current !== requestId) return;
        setCode(response.code);
        setSavedCode(response.code);
        setUpdatedAt(response.updatedAt);
      })
      .catch((caught: unknown) => {
        if (loadRequest.current !== requestId) return;
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(caught instanceof ApiError ? caught.message : '中间件加载失败。');
      })
      .finally(() => {
        if (loadRequest.current === requestId) setLoading(false);
      });

    return () => {
      controller.abort();
      if (loadRequest.current === requestId) loadRequest.current += 1;
    };
  }, [keyId]);

  const changed = code !== savedCode;
  const canSave = !loading && !saving && Boolean(code.trim()) && changed;

  const save = async () => {
    if (!code.trim() || code === savedCode || saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const response = await api<{ updatedAt: string }>(`/api/admin/keys/${keyId}/middleware`, {
        method: 'PUT',
        ...jsonBody({ code }),
      });
      setSavedCode(code);
      setUpdatedAt(response.updatedAt);
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '中间件保存失败。');
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <div
      id="key-panel-middleware"
      className="key-tab-panel middleware-tab-panel"
      role="tabpanel"
      aria-labelledby="key-tab-middleware"
    >
      <section className="middleware-panel">
        <div className="middleware-editor-frame">
          <div className="middleware-editor-toolbar">
            <div className="middleware-editor-status" aria-live="polite">
              {saved && !changed ? (
                <span className="middleware-saved-status">
                  <Check size={13} /> 已保存，下一请求生效
                </span>
              ) : changed ? (
                <span>有未保存修改</span>
              ) : updatedAt ? (
                <span>保存于 {formatFullDate(updatedAt)}</span>
              ) : (
                <span>middleware.js</span>
              )}
            </div>
            <Button loading={saving} disabled={!canSave} onClick={() => void save()}>
              <Save size={13} /> 保存
            </Button>
          </div>
          {loading ? (
            <Skeleton height={560} />
          ) : code ? (
            <Suspense fallback={<Skeleton height={560} />}>
              <MiddlewareCodeEditor
                value={code}
                canSave={canSave}
                onSave={save}
                onChange={(nextCode) => {
                  setCode(nextCode);
                  setSaved(false);
                  setError('');
                }}
              />
            </Suspense>
          ) : (
            <div className="middleware-editor-empty">中间件代码尚未加载。</div>
          )}
        </div>

        {error ? (
          <div className="form-error middleware-error" role="alert">
            {error}
          </div>
        ) : null}
      </section>
    </div>
  );
}
