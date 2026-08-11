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
import { copyText } from '../clipboard';
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

type ConnectionMethod = 'api-key' | 'oauth';
type ApiMode = 'responses' | 'chat.completions';

export function ProvidersPage() {
  const [providers, setProviders] = useState<Provider[]>();
  const [modal, setModal] = useState<'add' | null>(null);
  const [connectionMethod, setConnectionMethod] = useState<ConnectionMethod>('api-key');
  const [apiMode, setApiMode] = useState<ApiMode>('chat.completions');
  const [name, setName] = useState('OpenAI API');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [defaultModel, setDefaultModel] = useState('');
  const [flow, setFlow] = useState<DeviceFlow>();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const result = await api<{ providers: Provider[] }>('/api/admin/providers');
    setProviders(result.providers);
  }, []);
  useEffect(() => void load(), [load]);

  useEffect(() => {
    if (!flow) return;
    let cancelled = false;
    let timer: number | undefined;
    const pollIntervalMs = Math.max(flow.intervalSeconds, 5) * 1000;
    const maxRetryDelayMs = Math.max(30_000, pollIntervalMs);
    let retryDelayMs = pollIntervalMs;

    const schedule = (delayMs: number): void => {
      timer = window.setTimeout(() => void poll(), delayMs);
    };

    const poll = async (): Promise<void> => {
      try {
        const result = await api<{ status: string; providerConnectionId?: string }>(
          `/api/admin/providers/oauth/${flow.id}/poll`,
          { method: 'POST' },
        );
        if (cancelled) return;
        if (result.status === 'complete') {
          setFlow(undefined);
          setModal(null);
          setMessage('OpenAI OAuth 连接成功。');
          void load();
          return;
        }
        if (result.status === 'expired' || result.status === 'failed') {
          setFlow(undefined);
          setMessage('授权已过期或失败，请重新开始。');
          return;
        }
        retryDelayMs = pollIntervalMs;
        setMessage('');
        schedule(pollIntervalMs);
      } catch (error) {
        if (cancelled) return;
        const terminalOAuthError =
          error instanceof ApiError &&
          (error.code === 'openai_oauth_rejected' ||
            error.code === 'openai_oauth_invalid_response');
        const retryable =
          !terminalOAuthError && (!(error instanceof ApiError) || error.status >= 500);
        const detail = error instanceof ApiError ? error.message : '暂时无法检查 OAuth 状态';
        if (!retryable) {
          setFlow(undefined);
          setMessage(detail);
          return;
        }
        retryDelayMs = Math.min(Math.max(retryDelayMs * 2, 10_000), maxRetryDelayMs);
        setMessage(`${detail}；将自动重试。`);
        schedule(retryDelayMs);
      }
    };

    schedule(pollIntervalMs);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
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
          provider: 'openai',
          apiMode,
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

  const selectConnectionMethod = (method: ConnectionMethod) => {
    setConnectionMethod(method);
    setName(method === 'api-key' ? 'OpenAI API' : 'OpenAI OAuth');
    setFlow(undefined);
  };

  const openAddProviderModal = () => {
    selectConnectionMethod('api-key');
    setApiMode('chat.completions');
    setApiKey('');
    setBaseUrl('https://api.openai.com/v1');
    setDefaultModel('');
    setFlow(undefined);
    setModal('add');
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
        title="上游连接"
        action={
          <Button onClick={openAddProviderModal}>
            <Plus size={14} /> 添加上游
          </Button>
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
                  <span>API 方式</span>
                  <code>
                    {provider.authType === 'oauth' || provider.apiMode === 'responses'
                      ? 'Responses'
                      : 'Chat Completions'}
                  </code>
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
          description="添加 OpenAI 上游，并选择 API Key 或 OAuth 接入。"
          action={
            <Button onClick={openAddProviderModal}>
              <Plus size={14} /> 添加上游
            </Button>
          }
        />
      )}

      {modal === 'add' ? (
        <Modal
          title="添加上游连接"
          onClose={() => {
            setModal(null);
            setFlow(undefined);
          }}
        >
          {flow ? (
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
                type="button"
                className="device-code"
                onClick={() => void copyText(flow.userCode)}
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
          ) : connectionMethod === 'oauth' ? (
            <form className="modal-body" onSubmit={(event) => void startOAuth(event)}>
              <Field label="Provider">
                <select className="input" value="openai" disabled>
                  <option value="openai">OpenAI</option>
                </select>
              </Field>
              <Field label="接入方式">
                <select
                  className="input"
                  value={connectionMethod}
                  onChange={(event) =>
                    selectConnectionMethod(event.target.value as ConnectionMethod)
                  }
                >
                  <option value="api-key">API Key</option>
                  <option value="oauth">OAuth</option>
                </select>
              </Field>
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
            <form className="modal-body" onSubmit={(event) => void createApiKeyProvider(event)}>
              <Field label="Provider">
                <select className="input" value="openai" disabled>
                  <option value="openai">OpenAI</option>
                </select>
              </Field>
              <Field label="接入方式">
                <select
                  className="input"
                  value={connectionMethod}
                  onChange={(event) =>
                    selectConnectionMethod(event.target.value as ConnectionMethod)
                  }
                >
                  <option value="api-key">API Key</option>
                  <option value="oauth">OAuth</option>
                </select>
              </Field>
              <Field label="接口类型" hint="使用 OpenAI 兼容的请求与响应格式。">
                <select className="input" value="openai-compatible" disabled>
                  <option value="openai-compatible">OpenAI Compatible</option>
                </select>
              </Field>
              <Field
                label="API 方式"
                hint={`请求会发送到 ${
                  apiMode === 'responses' ? '/responses' : '/chat/completions'
                }。`}
              >
                <select
                  className="input"
                  value={apiMode}
                  onChange={(event) => setApiMode(event.target.value as ApiMode)}
                >
                  <option value="responses">Responses API</option>
                  <option value="chat.completions">Chat Completions API</option>
                </select>
              </Field>
              <Field label="连接名称">
                <Input value={name} onChange={(event) => setName(event.target.value)} required />
              </Field>
              <Field label="API Key" hint="只会以加密形式存储。">
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="输入上游 API Key"
                  required
                />
              </Field>
              <Field
                label="Base URL"
                hint="可从常用地址中选择，也可以直接输入自定义域名；不包含接口路径。"
              >
                <Input
                  type="url"
                  list="openai-compatible-base-urls"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="https://api.example.com/v1"
                  required
                />
                <datalist id="openai-compatible-base-urls">
                  <option value="https://api.openai.com/v1">OpenAI</option>
                  <option value="https://openrouter.ai/api/v1">OpenRouter</option>
                  <option value="https://api.siliconflow.cn/v1">SiliconFlow</option>
                </datalist>
              </Field>
              <Field label="默认模型（可选）">
                <Input
                  value={defaultModel}
                  onChange={(event) => setDefaultModel(event.target.value)}
                  placeholder="例如 gpt-4.1"
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
          )}
        </Modal>
      ) : null}
    </div>
  );
}
