import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Check,
  CircleAlert,
  Copy,
  KeyRound,
  Link2,
  MoreHorizontal,
  PlugZap,
  Plus,
  RefreshCcw,
  Trash2,
} from 'lucide-react';

import { api, ApiError, jsonBody } from '../api';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Skeleton,
} from '../components/ui';
import type { Provider } from '../types';

interface DeviceFlow {
  id: string;
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
  expiresAt: string;
}

export function ProvidersPage() {
  const [providers, setProviders] = useState<Provider[]>();
  const [modal, setModal] = useState<'oauth' | 'api-key' | null>(null);
  const [name, setName] = useState('OpenAI');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [defaultModel, setDefaultModel] = useState('');
  const [flow, setFlow] = useState<DeviceFlow>();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const response = await api<{ providers: Provider[] }>('/api/admin/providers');
    setProviders(response.providers);
  }, []);
  useEffect(() => void load(), [load]);

  useEffect(() => {
    if (!flow) return;
    const timer = window.setInterval(
      () => {
        void api<{ status: string; providerConnectionId?: string }>(
          `/api/admin/providers/oauth/${flow.id}/poll`,
          { method: 'POST' },
        )
          .then((result) => {
            if (result.status === 'complete') {
              window.clearInterval(timer);
              setFlow(undefined);
              setModal(null);
              setMessage('OpenAI OAuth 连接成功。');
              void load();
            } else if (result.status === 'expired' || result.status === 'failed') {
              window.clearInterval(timer);
              setMessage('授权已过期，请重新开始。');
            }
          })
          .catch(() => undefined);
      },
      Math.max(flow.intervalSeconds, 5) * 1000,
    );
    return () => window.clearInterval(timer);
  }, [flow, load]);

  const startOAuth = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      const response = await api<DeviceFlow>('/api/admin/providers/oauth/start', {
        method: 'POST',
        ...jsonBody({ name }),
      });
      setFlow(response);
      window.open(response.verificationUrl, '_blank', 'noopener,noreferrer');
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : '无法开始 OAuth。');
    } finally {
      setLoading(false);
    }
  };

  const createApiKeyProvider = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      await api('/api/admin/providers/api-key', {
        method: 'POST',
        ...jsonBody({
          name,
          apiKey,
          baseUrl,
          defaultModel: defaultModel || undefined,
          priority: 100,
        }),
      });
      setModal(null);
      setApiKey('');
      setMessage('API Key 连接已添加。');
      await load();
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : '保存失败。');
    } finally {
      setLoading(false);
    }
  };

  const toggle = async (provider: Provider) => {
    await api(`/api/admin/providers/${provider.id}`, {
      method: 'PATCH',
      ...jsonBody({ status: provider.status === 'active' ? 'disabled' : 'active' }),
    });
    await load();
  };
  const remove = async (provider: Provider) => {
    if (!window.confirm(`确定删除连接“${provider.name}”吗？关联 Key 将回退到默认连接。`)) return;
    await api(`/api/admin/providers/${provider.id}`, { method: 'DELETE' });
    await load();
  };

  return (
    <div className="page-wrap">
      <PageHeader
        eyebrow="Upstream connections"
        title="上游连接"
        description="模型账号与路由顺序"
        action={
          <div className="button-group">
            <Button
              variant="secondary"
              onClick={() => {
                setModal('api-key');
                setFlow(undefined);
              }}
            >
              <KeyRound size={14} /> API Key
            </Button>
            <Button
              onClick={() => {
                setModal('oauth');
                setFlow(undefined);
              }}
            >
              <Plus size={14} /> GPT OAuth
            </Button>
          </div>
        }
      />
      {message ? (
        <div
          className={
            message.includes('成功') || message.includes('添加')
              ? 'notice success'
              : 'notice warning'
          }
        >
          {message}
        </div>
      ) : null}
      {!providers ? (
        <Skeleton height={300} />
      ) : providers.length ? (
        <div className="provider-grid">
          {providers.map((provider) => (
            <article className="provider-card" key={provider.id}>
              <div className="provider-card-top">
                <div className="provider-logo">
                  {provider.authType === 'oauth' ? <PlugZap size={19} /> : <KeyRound size={19} />}
                </div>
                <div className="provider-title">
                  <div>
                    <h3>{provider.name}</h3>
                    <Badge tone={provider.authType === 'oauth' ? 'blue' : 'neutral'}>
                      {provider.authType === 'oauth' ? 'OAuth' : 'API Key'}
                    </Badge>
                  </div>
                  <span>OpenAI · 优先级 {provider.priority}</span>
                </div>
                <button className="icon-button">
                  <MoreHorizontal size={17} />
                </button>
              </div>
              <div className="provider-meta">
                <div>
                  <span>状态</span>
                  <Badge
                    tone={
                      provider.status === 'active'
                        ? 'success'
                        : provider.status === 'error'
                          ? 'danger'
                          : 'warning'
                    }
                  >
                    {provider.status === 'active'
                      ? 'Active'
                      : provider.status === 'error'
                        ? 'Error'
                        : 'Disabled'}
                  </Badge>
                </div>
                <div>
                  <span>默认模型</span>
                  <code>{provider.defaultModel || 'Request model'}</code>
                </div>
                <div>
                  <span>Base URL</span>
                  <code title={provider.baseUrl}>
                    {provider.baseUrl.replace(/^https?:\/\//, '').slice(0, 36)}
                  </code>
                </div>
                {provider.accountId ? (
                  <div>
                    <span>Account</span>
                    <code>{provider.accountId.slice(0, 18)}…</code>
                  </div>
                ) : null}
              </div>
              {provider.lastError ? (
                <div className="provider-error">
                  <CircleAlert size={14} /> {provider.lastError}
                </div>
              ) : null}
              <div className="provider-actions">
                <Button variant="secondary" onClick={() => void toggle(provider)}>
                  {provider.status === 'active' ? '停用' : '启用'}
                </Button>
                <Button variant="ghost" onClick={() => void remove(provider)}>
                  <Trash2 size={14} /> 删除
                </Button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          title="还没有上游连接"
          description="添加 OAuth 或 API Key。"
          action={
            <Button onClick={() => setModal('oauth')}>
              <Link2 size={14} /> 连接 OpenAI
            </Button>
          }
        />
      )}

      {modal === 'oauth' ? (
        <Modal
          title="连接 GPT OAuth"
          onClose={() => {
            setModal(null);
            setFlow(undefined);
          }}
        >
          {!flow ? (
            <form className="modal-body" onSubmit={(event) => void startOAuth(event)}>
              <div className="oauth-intro">
                <div className="oauth-icon">
                  <PlugZap size={22} />
                </div>
                <div>
                  <strong>使用 ChatGPT 设备授权</strong>
                  <p>不会要求你在 xRouter 中输入 ChatGPT 密码。授权令牌会加密保存在 PostgreSQL。</p>
                </div>
              </div>
              <Field label="连接名称">
                <Input value={name} onChange={(event) => setName(event.target.value)} required />
              </Field>
              <div className="modal-actions">
                <Button type="button" variant="secondary" onClick={() => setModal(null)}>
                  取消
                </Button>
                <Button type="submit" loading={loading}>
                  开始授权 <Link2 size={14} />
                </Button>
              </div>
            </form>
          ) : (
            <div className="modal-body device-flow">
              <div className="device-status">
                <RefreshCcw size={17} className="spin" />
                <div>
                  <strong>等待浏览器确认</strong>
                  <p>
                    在 OpenAI 页面输入以下一次性代码。授权将在{' '}
                    {new Date(flow.expiresAt).toLocaleTimeString('zh-CN')} 过期。
                  </p>
                </div>
              </div>
              <button
                className="device-code"
                onClick={() => void navigator.clipboard.writeText(flow.userCode)}
              >
                <code>{flow.userCode}</code>
                <Copy size={16} />
              </button>
              <a
                className="button button-primary"
                href={flow.verificationUrl}
                target="_blank"
                rel="noreferrer"
              >
                打开 OpenAI 授权页 <Link2 size={14} />
              </a>
              <div className="security-note">
                <Check size={13} /> 仅继续你本人从此页面发起的授权。
              </div>
            </div>
          )}
        </Modal>
      ) : null}
      {modal === 'api-key' ? (
        <Modal title="添加 OpenAI API Key" onClose={() => setModal(null)}>
          <form className="modal-body" onSubmit={(event) => void createApiKeyProvider(event)}>
            <Field label="连接名称">
              <Input value={name} onChange={(event) => setName(event.target.value)} required />
            </Field>
            <Field label="OpenAI API Key" hint="只会以加密形式存储。">
              <Input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-…"
                required
              />
            </Field>
            <Field label="Base URL">
              <Input
                type="url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                required
              />
            </Field>
            <Field label="默认模型（可选）">
              <Input
                value={defaultModel}
                onChange={(event) => setDefaultModel(event.target.value)}
                placeholder="gpt-5.6"
              />
            </Field>
            <div className="modal-actions">
              <Button type="button" variant="secondary" onClick={() => setModal(null)}>
                取消
              </Button>
              <Button type="submit" loading={loading}>
                保存连接
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
