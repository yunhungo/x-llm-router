import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Check,
  CircleAlert,
  Copy,
  KeyRound,
  Link2,
  Pencil,
  PlugZap,
  Plus,
  RefreshCcw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';

import { api, ApiError, jsonBody } from '../../api';
import { copyText } from '../../clipboard';
import {
  Badge,
  Button,
  ComboboxInput,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Skeleton,
} from '../../components/ui';
import type { Provider, ProviderCatalogItem } from '../../types';
import './providers.css';

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
  const [catalog, setCatalog] = useState<ProviderCatalogItem[]>([]);
  const [providerId, setProviderId] = useState('openai');
  const [modal, setModal] = useState<'add' | 'edit' | null>(null);
  const [editingProvider, setEditingProvider] = useState<Provider>();
  const [connectionMethod, setConnectionMethod] = useState<ConnectionMethod>('api-key');
  const [apiMode, setApiMode] = useState<ApiMode>('chat.completions');
  const [name, setName] = useState('OpenAI API');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [defaultModel, setDefaultModel] = useState('');
  const [priority, setPriority] = useState('100');
  const [flow, setFlow] = useState<DeviceFlow>();
  const [loading, setLoading] = useState(false);
  const [refreshingModels, setRefreshingModels] = useState('');
  const [message, setMessage] = useState('');
  const [modalError, setModalError] = useState('');

  const load = useCallback(async () => {
    const [connections, registered] = await Promise.all([
      api<{ providers: Provider[] }>('/api/admin/providers'),
      api<{ providers: ProviderCatalogItem[] }>('/api/admin/provider-catalog'),
    ]);
    setProviders(connections.providers);
    setCatalog(registered.providers);
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
        const result = await api<{
          status: string;
          providerConnectionId?: string;
          modelsCount?: number;
          modelsWarning?: string;
        }>(`/api/admin/providers/oauth/${flow.id}/poll`, { method: 'POST' });
        if (cancelled) return;
        if (result.status === 'complete') {
          setFlow(undefined);
          setModal(null);
          setMessage(
            result.modelsWarning
              ? `OpenAI OAuth 连接成功，但模型同步失败：${result.modelsWarning}`
              : `OpenAI OAuth 连接成功，已同步 ${result.modelsCount ?? 0} 个模型。`,
          );
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
          provider: providerId,
          apiMode,
          apiKey,
          baseUrl,
          defaultModel: defaultModel || undefined,
          priority: Number(priority),
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
    if (method === 'oauth') setProviderId('openai');
    setName(method === 'api-key' ? 'OpenAI API' : 'OpenAI OAuth');
    setFlow(undefined);
  };

  const openAddProviderModal = () => {
    selectConnectionMethod('api-key');
    setProviderId('openai');
    setApiMode('chat.completions');
    setApiKey('');
    setBaseUrl('https://api.openai.com/v1');
    setDefaultModel('');
    setPriority('100');
    setFlow(undefined);
    setEditingProvider(undefined);
    setModalError('');
    setModal('add');
  };

  const selectProvider = (nextProviderId: string) => {
    const selected = catalog.find((provider) => provider.id === nextProviderId);
    setProviderId(nextProviderId);
    setConnectionMethod('api-key');
    setName(selected ? `${selected.name} API` : 'Upstream API');
    setBaseUrl(selected?.defaultApiBaseUrl ?? '');
    setDefaultModel(selected?.defaultModel ?? '');
    setApiMode(selected?.defaultApiMode ?? 'chat.completions');
  };

  const openEditProviderModal = (provider: Provider) => {
    setEditingProvider(provider);
    setConnectionMethod(provider.authType === 'oauth' ? 'oauth' : 'api-key');
    setApiMode(provider.apiMode);
    setName(provider.name);
    setApiKey('');
    setBaseUrl(provider.baseUrl);
    setDefaultModel(provider.defaultModel ?? '');
    setPriority(String(provider.priority));
    setFlow(undefined);
    setModalError('');
    setModal('edit');
  };

  const saveProvider = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingProvider) return;
    setLoading(true);
    setModalError('');
    try {
      const nextApiKey = apiKey.trim();
      await api(`/api/admin/providers/${editingProvider.id}`, {
        method: 'PATCH',
        ...jsonBody({
          name,
          defaultModel: defaultModel.trim() || null,
          priority: Number(priority),
          ...(editingProvider.authType === 'api_key'
            ? {
                apiMode,
                baseUrl,
                ...(nextApiKey ? { apiKey: nextApiKey } : {}),
              }
            : {}),
        }),
      });
      setModal(null);
      setEditingProvider(undefined);
      setApiKey('');
      setMessage(`连接“${name.trim()}”已更新。`);
      await load();
    } catch (error) {
      setModalError(error instanceof ApiError ? error.message : '保存失败，请稍后重试。');
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
  const refreshModels = async (provider: Provider) => {
    setRefreshingModels(provider.id);
    setMessage('');
    try {
      const result = await api<{ models: string[]; refreshedAt: string }>(
        `/api/admin/providers/${provider.id}/models/refresh`,
        { method: 'POST' },
      );
      setMessage(`模型同步成功，共 ${result.models.length} 个。`);
      await load();
    } catch (error) {
      setMessage(`模型同步失败：${error instanceof ApiError ? error.message : '请稍后重试。'}`);
      await load();
    } finally {
      setRefreshingModels('');
    }
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
            message.includes('成功') && !message.includes('失败')
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
                  <span>
                    {catalog.find((item) => item.id === provider.provider)?.name ??
                      provider.provider}{' '}
                    · 优先级 {provider.priority}
                  </span>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => openEditProviderModal(provider)}
                  aria-label={`编辑 ${provider.name}`}
                  title="编辑连接"
                >
                  <Pencil size={15} />
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
                    {provider.authType === 'oauth'
                      ? 'Responses'
                      : provider.provider === 'custom'
                        ? provider.apiMode === 'responses'
                          ? 'Responses'
                          : 'Chat Completions'
                        : 'Pi AI · Auto'}
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
              {provider.models.length || provider.authType === 'oauth' ? (
                <section className="provider-models" aria-label={`${provider.name} 可用模型`}>
                  <div className="provider-models-heading">
                    <div>
                      <strong>可用模型</strong>
                      <span>
                        {provider.modelsRefreshedAt
                          ? `同步于 ${new Date(provider.modelsRefreshedAt).toLocaleString('zh-CN')}`
                          : '尚未同步'}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      loading={refreshingModels === provider.id}
                      disabled={provider.status !== 'active'}
                      onClick={() => void refreshModels(provider)}
                    >
                      <RefreshCcw size={13} /> 刷新
                    </Button>
                  </div>
                  {provider.models?.length ? (
                    <div className="provider-model-list">
                      {provider.models.map((model) => (
                        <code key={model}>{model}</code>
                      ))}
                    </div>
                  ) : (
                    <p>点击刷新以同步或恢复此 Provider 当前可用的模型。</p>
                  )}
                  {provider.modelsRefreshError ? (
                    <div className="provider-model-error">
                      <CircleAlert size={13} /> {provider.modelsRefreshError}
                    </div>
                  ) : null}
                </section>
              ) : null}
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
          description="从 Pi AI 的预置 Provider 中选择，或添加自定义 OpenAI-compatible 上游。"
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
                <select
                  className="input"
                  value={providerId}
                  onChange={(event) => selectProvider(event.target.value)}
                >
                  {catalog.map((provider) => (
                    <option value={provider.id} key={provider.id}>
                      {provider.name}
                    </option>
                  ))}
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
                  <option value="oauth" disabled={providerId !== 'openai'}>
                    OAuth（仅 OpenAI）
                  </option>
                </select>
              </Field>
              <Field label="运行时" hint="请求构建、流解析和用量归一化由 Pi AI 完成。">
                <select className="input" value="pi-ai" disabled>
                  <option value="pi-ai">Pi AI</option>
                </select>
              </Field>
              {providerId === 'custom' ? (
                <Field
                  label="自定义上游协议"
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
              ) : null}
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
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="https://api.example.com/v1"
                  required
                />
              </Field>
              <Field label="默认模型（可选）">
                <ComboboxInput
                  value={defaultModel}
                  options={catalog.find((provider) => provider.id === providerId)?.models ?? []}
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

      {modal === 'edit' && editingProvider ? (
        <Modal
          title="编辑上游连接"
          onClose={() => {
            setModal(null);
            setEditingProvider(undefined);
            setModalError('');
          }}
        >
          <form className="modal-body" onSubmit={(event) => void saveProvider(event)}>
            <div className="provider-edit-summary">
              <div className="provider-logo">
                {editingProvider.authType === 'oauth' ? (
                  <PlugZap size={18} />
                ) : (
                  <KeyRound size={18} />
                )}
              </div>
              <div className="provider-edit-copy">
                <strong>{editingProvider.name}</strong>
                <span>
                  {editingProvider.authType === 'oauth'
                    ? 'OpenAI OAuth'
                    : `${
                        catalog.find((provider) => provider.id === editingProvider.provider)
                          ?.name ?? editingProvider.provider
                      } · Pi AI`}
                  {' · '}
                  {editingProvider.status === 'active' ? '已启用' : '未启用'}
                </span>
              </div>
              <Badge tone={editingProvider.authType === 'oauth' ? 'blue' : 'neutral'}>
                {editingProvider.authType === 'oauth' ? 'OAuth' : 'API Key'}
              </Badge>
            </div>

            <div className="form-grid">
              <Field label="连接名称">
                <Input value={name} onChange={(event) => setName(event.target.value)} required />
              </Field>
              <Field label="优先级" hint="数字越小越优先。">
                <Input
                  type="number"
                  min="0"
                  max="10000"
                  step="1"
                  value={priority}
                  onChange={(event) => setPriority(event.target.value)}
                  required
                />
              </Field>
            </div>

            <Field
              label="默认模型（可选）"
              hint="请求未传 model 时使用；留空则要求调用方指定模型。"
            >
              <ComboboxInput
                value={defaultModel}
                options={editingProvider.models}
                onChange={(event) => setDefaultModel(event.target.value)}
                placeholder="Request model"
              />
            </Field>

            {editingProvider.authType === 'api_key' ? (
              <>
                <div className="modal-section-label">上游 API</div>
                {editingProvider.provider === 'custom' ? (
                  <Field
                    label="自定义上游协议"
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
                ) : (
                  <div className="security-note provider-credential-note">
                    <ShieldCheck size={14} /> Pi AI 会按所选模型自动选择并转换上游协议。
                  </div>
                )}
                <Field label="Base URL" hint="不包含 /responses 或 /chat/completions 路径。">
                  <Input
                    type="url"
                    list="openai-compatible-base-urls"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    required
                  />
                </Field>
                <Field label="替换 API Key（可选）" hint="留空会保留当前加密凭据。">
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="输入新密钥以替换当前凭据"
                    minLength={12}
                  />
                </Field>
              </>
            ) : (
              <div className="security-note provider-credential-note">
                <ShieldCheck size={14} /> OAuth 凭据由系统自动续期；此处只编辑路由配置。
              </div>
            )}

            {modalError ? <div className="form-error">{modalError}</div> : null}
            <div className="modal-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setModal(null);
                  setEditingProvider(undefined);
                  setModalError('');
                }}
              >
                取消
              </Button>
              <Button type="submit" loading={loading}>
                保存更改
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
