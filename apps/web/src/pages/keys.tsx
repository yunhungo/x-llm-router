import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  BarChart3,
  Check,
  Copy,
  KeyRound,
  Plus,
  ShieldCheck,
  Trash2,
  Waypoints,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { api, ApiError, jsonBody } from '../api';
import { Button, EmptyState, Field, Input, Modal, PageHeader, Skeleton } from '../components/ui';
import type { LangfuseConfig, Provider, VirtualKey } from '../types';

interface CreatedKey {
  id: string;
  rawKey: string;
  prefix: string;
  warning: string;
}

interface LangfuseDraft {
  enabled: boolean;
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  environment: string;
  traceName: string;
  version: string;
  tags: string;
  metadata: Array<{ key: string; value: string }>;
  userIdHeader: string;
  sessionIdHeader: string;
  captureInput: boolean;
  captureOutput: boolean;
}

const emptyLangfuse = (): LangfuseDraft => ({
  enabled: false,
  publicKey: '',
  secretKey: '',
  baseUrl: 'https://cloud.langfuse.com',
  environment: 'production',
  traceName: '',
  version: '',
  tags: 'gateway',
  metadata: [],
  userIdHeader: 'x-user-id',
  sessionIdHeader: 'x-session-id',
  captureInput: true,
  captureOutput: true,
});

function langfuseDraft(config: LangfuseConfig): LangfuseDraft {
  return {
    enabled: Boolean(config.enabled),
    publicKey: config.publicKey ?? '',
    secretKey: '',
    baseUrl: config.baseUrl ?? 'https://cloud.langfuse.com',
    environment: config.environment ?? 'production',
    traceName: config.traceName ?? '',
    version: config.version ?? '',
    tags: config.tags?.join(', ') ?? 'gateway',
    metadata: Object.entries(config.metadata ?? {}).map(([key, value]) => ({ key, value })),
    userIdHeader: config.userIdHeader ?? 'x-user-id',
    sessionIdHeader: config.sessionIdHeader ?? 'x-session-id',
    captureInput: config.captureInput ?? true,
    captureOutput: config.captureOutput ?? true,
  };
}

function langfusePayload(value: LangfuseDraft) {
  return {
    ...value,
    tags: [
      ...new Set(
        value.tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ],
    metadata: Object.fromEntries(
      value.metadata
        .map((entry) => [entry.key.trim(), entry.value] as const)
        .filter(([key]) => Boolean(key)),
    ),
  };
}

function LangfuseFields({
  value,
  onChange,
  hasSecretKey = false,
}: {
  value: LangfuseDraft;
  onChange: (value: LangfuseDraft) => void;
  hasSecretKey?: boolean;
}) {
  return (
    <div className="langfuse-fields">
      <label className="switch-row compact">
        <div>
          <strong>Langfuse</strong>
          <span>此 Key 的独立项目</span>
        </div>
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
        />
        <i />
      </label>
      {value.enabled ? (
        <>
          <div className="form-grid">
            <Field label="Public Key">
              <Input
                value={value.publicKey}
                onChange={(event) => onChange({ ...value, publicKey: event.target.value })}
                placeholder="pk-lf-…"
                required
              />
            </Field>
            <Field label="Secret Key" {...(hasSecretKey ? { hint: '留空保持不变' } : {})}>
              <Input
                type="password"
                value={value.secretKey}
                onChange={(event) => onChange({ ...value, secretKey: event.target.value })}
                placeholder={hasSecretKey ? '••••••••' : 'sk-lf-…'}
                required={!hasSecretKey}
              />
            </Field>
          </div>
          <Field label="Base URL">
            <Input
              type="url"
              value={value.baseUrl}
              onChange={(event) => onChange({ ...value, baseUrl: event.target.value })}
              required
            />
          </Field>
          <Field label="Environment">
            <Input
              value={value.environment}
              onChange={(event) => onChange({ ...value, environment: event.target.value })}
              placeholder="production"
              required
            />
          </Field>
          <div className="form-grid">
            <Field label="Trace Name" hint="留空时按 API 端点命名">
              <Input
                value={value.traceName}
                onChange={(event) => onChange({ ...value, traceName: event.target.value })}
                placeholder="llm-gateway"
              />
            </Field>
            <Field label="Version" hint="用于比较版本变更">
              <Input
                value={value.version}
                onChange={(event) => onChange({ ...value, version: event.target.value })}
                placeholder="2026.08.11"
              />
            </Field>
          </div>
          <Field label="Tags" hint="用逗号分隔，适合低基数业务维度">
            <Input
              value={value.tags}
              onChange={(event) => onChange({ ...value, tags: event.target.value })}
              placeholder="gateway, production"
            />
          </Field>
          <div className="form-grid">
            <Field label="User ID Header" hint="映射到 Langfuse userId">
              <Input
                value={value.userIdHeader}
                onChange={(event) => onChange({ ...value, userIdHeader: event.target.value })}
                placeholder="x-user-id"
              />
            </Field>
            <Field label="Session ID Header" hint="映射到 Langfuse sessionId">
              <Input
                value={value.sessionIdHeader}
                onChange={(event) => onChange({ ...value, sessionIdHeader: event.target.value })}
                placeholder="x-session-id"
              />
            </Field>
          </div>
          <div className="langfuse-capture-options">
            <label>
              <input
                type="checkbox"
                checked={value.captureInput}
                onChange={(event) => onChange({ ...value, captureInput: event.target.checked })}
              />
              <span>记录请求 Input</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={value.captureOutput}
                onChange={(event) => onChange({ ...value, captureOutput: event.target.checked })}
              />
              <span>记录响应 Output</span>
            </label>
          </div>
          <div className="langfuse-metadata-editor">
            <div className="langfuse-section-heading">
              <div>
                <strong>自定义 Metadata</strong>
                <span>按 Langfuse metadata 字符串键值传入</span>
              </div>
              <button
                type="button"
                className="button button-secondary langfuse-add-field"
                onClick={() =>
                  onChange({ ...value, metadata: [...value.metadata, { key: '', value: '' }] })
                }
              >
                <Plus size={13} /> 添加字段
              </button>
            </div>
            {value.metadata.map((entry, index) => (
              <div className="langfuse-metadata-row" key={index}>
                <Input
                  value={entry.key}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      metadata: value.metadata.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, key: event.target.value } : item,
                      ),
                    })
                  }
                  placeholder="字段名，例如 tenant"
                  aria-label={`Metadata 字段 ${index + 1} 名称`}
                  required
                />
                <Input
                  value={entry.value}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      metadata: value.metadata.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, value: event.target.value } : item,
                      ),
                    })
                  }
                  placeholder="字段值"
                  aria-label={`Metadata 字段 ${index + 1} 值`}
                />
                <button
                  type="button"
                  className="icon-button danger-icon"
                  onClick={() =>
                    onChange({
                      ...value,
                      metadata: value.metadata.filter((_, itemIndex) => itemIndex !== index),
                    })
                  }
                  aria-label={`删除 Metadata 字段 ${index + 1}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function KeysPage() {
  const navigate = useNavigate();
  const [keys, setKeys] = useState<VirtualKey[]>();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [created, setCreated] = useState<CreatedKey>();
  const [editingKey, setEditingKey] = useState<VirtualKey>();
  const [editingLangfuse, setEditingLangfuse] = useState<LangfuseDraft>();
  const [name, setName] = useState('Development');
  const [rpm, setRpm] = useState(60);
  const [budget, setBudget] = useState('');
  const [providerId, setProviderId] = useState('');
  const [langfuse, setLangfuse] = useState<LangfuseDraft>(emptyLangfuse);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const [keyResult, providerResult] = await Promise.all([
      api<{ keys: VirtualKey[] }>('/api/admin/keys'),
      api<{ providers: Provider[] }>('/api/admin/providers'),
    ]);
    setKeys(keyResult.keys);
    setProviders(providerResult.providers.filter((provider) => provider.status === 'active'));
  }, []);
  useEffect(() => void load(), [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const response = await api<CreatedKey>('/api/admin/keys', {
        method: 'POST',
        ...jsonBody({
          name,
          rpmLimit: rpm,
          budgetUsd: budget ? Number(budget) : null,
          providerConnectionId: providerId || null,
          langfuse: langfusePayload(langfuse),
        }),
      });
      setCreated(response);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '创建失败。');
    } finally {
      setLoading(false);
    }
  };

  const saveLangfuse = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingKey || !editingLangfuse) return;
    setLoading(true);
    setError('');
    try {
      await api(`/api/admin/keys/${editingKey.id}/langfuse`, {
        method: 'PUT',
        ...jsonBody({
          ...langfusePayload(editingLangfuse),
          secretKey: editingLangfuse.secretKey || undefined,
        }),
      });
      setEditingKey(undefined);
      setEditingLangfuse(undefined);
      setNotice('Langfuse 已保存，重启 API 后生效。');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '保存失败。');
    } finally {
      setLoading(false);
    }
  };

  const revoke = async (key: VirtualKey) => {
    if (!window.confirm(`撤销“${key.name}”？`)) return;
    await api(`/api/admin/keys/${key.id}/revoke`, { method: 'POST' });
    await load();
  };

  return (
    <div className="page-wrap">
      <PageHeader
        title="API Keys"
        action={
          <Button
            onClick={() => {
              setShowCreate(true);
              setCreated(undefined);
              setLangfuse(emptyLangfuse());
              setError('');
            }}
          >
            <Plus size={14} /> 创建 Key
          </Button>
        }
      />
      {notice ? <div className="notice compact-notice">{notice}</div> : null}
      {!keys ? (
        <Skeleton height={360} />
      ) : keys.length ? (
        <section className="panel flush-panel">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>Key</th>
                  <th>上游</th>
                  <th>Langfuse</th>
                  <th>RPM</th>
                  <th>预算 / 已用</th>
                  <th>最近调用</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr
                    key={key.id}
                    className="clickable-row"
                    tabIndex={0}
                    onClick={() => navigate(`/keys/${key.id}`)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        navigate(`/keys/${key.id}`);
                      }
                    }}
                  >
                    <td>
                      <strong>{key.name}</strong>
                      <small>{key.status === 'active' ? 'Active' : 'Revoked'}</small>
                    </td>
                    <td>
                      <code>{key.keyPrefix}</code>
                    </td>
                    <td>{key.providerName ?? '自动路由'}</td>
                    <td>
                      {key.langfuse.enabled && key.langfuse.publicKey ? (
                        <small>{key.langfuse.publicKey}</small>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{key.rpmLimit.toLocaleString()}</td>
                    <td>
                      {key.budgetUsd === null ? 'Unlimited' : `$${key.budgetUsd.toFixed(2)}`}
                      <small>${key.spendUsd.toFixed(4)} used</small>
                    </td>
                    <td>
                      {key.lastUsedAt
                        ? new Date(key.lastUsedAt).toLocaleString('zh-CN', {
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : 'Never'}
                    </td>
                    <td>
                      <div className="key-actions">
                        <button
                          className="icon-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            navigate(`/keys/${key.id}`);
                          }}
                          aria-label={`查看 ${key.name} 的调用情况`}
                        >
                          <BarChart3 size={15} />
                        </button>
                        <button
                          className="icon-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setEditingKey(key);
                            setEditingLangfuse(langfuseDraft(key.langfuse));
                            setError('');
                          }}
                          aria-label={`配置 ${key.name} 的 Langfuse`}
                        >
                          <Waypoints size={15} />
                        </button>
                        <button
                          className="icon-button danger-icon"
                          disabled={key.status !== 'active'}
                          onClick={(event) => {
                            event.stopPropagation();
                            void revoke(key);
                          }}
                          aria-label="撤销"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <EmptyState
          title="还没有 API Key"
          description="创建后即可调用网关。"
          action={
            <Button onClick={() => setShowCreate(true)}>
              <KeyRound size={14} /> 创建 Key
            </Button>
          }
        />
      )}

      {showCreate ? (
        <Modal
          title={created ? '保存 API Key' : '创建 API Key'}
          onClose={() => {
            setShowCreate(false);
            setCreated(undefined);
          }}
        >
          {created ? (
            <div className="modal-body created-key">
              <div className="created-check">
                <Check size={22} />
              </div>
              <h3>Key 已创建</h3>
              <button
                className="secret-key"
                onClick={() => {
                  void navigator.clipboard.writeText(created.rawKey);
                  setCopied(true);
                }}
              >
                <code>{created.rawKey}</code>
                <span>{copied ? <Check size={15} /> : <Copy size={15} />}</span>
              </button>
              <div className="security-note">
                <ShieldCheck size={14} /> 仅显示一次
              </div>
              <div className="modal-actions">
                <Button onClick={() => setShowCreate(false)}>完成</Button>
              </div>
            </div>
          ) : (
            <form className="modal-body" onSubmit={(event) => void create(event)}>
              <Field label="名称">
                <Input value={name} onChange={(event) => setName(event.target.value)} required />
              </Field>
              <div className="form-grid">
                <Field label="RPM">
                  <Input
                    type="number"
                    min={1}
                    max={100000}
                    value={rpm}
                    onChange={(event) => setRpm(Number(event.target.value))}
                    required
                  />
                </Field>
                <Field label="预算 USD">
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={budget}
                    onChange={(event) => setBudget(event.target.value)}
                    placeholder="Unlimited"
                  />
                </Field>
              </div>
              <Field label="固定上游">
                <select
                  className="input"
                  value={providerId}
                  onChange={(event) => setProviderId(event.target.value)}
                >
                  <option value="">自动路由</option>
                  {providers.map((provider) => (
                    <option value={provider.id} key={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </select>
              </Field>
              <LangfuseFields value={langfuse} onChange={setLangfuse} />
              {error ? <div className="form-error">{error}</div> : null}
              <div className="modal-actions">
                <Button type="button" variant="secondary" onClick={() => setShowCreate(false)}>
                  取消
                </Button>
                <Button type="submit" loading={loading}>
                  创建
                </Button>
              </div>
            </form>
          )}
        </Modal>
      ) : null}

      {editingKey && editingLangfuse ? (
        <Modal
          title={`Langfuse · ${editingKey.name}`}
          onClose={() => {
            setEditingKey(undefined);
            setEditingLangfuse(undefined);
          }}
        >
          <form className="modal-body" onSubmit={(event) => void saveLangfuse(event)}>
            <LangfuseFields
              value={editingLangfuse}
              onChange={setEditingLangfuse}
              hasSecretKey={editingKey.langfuse.hasSecretKey}
            />
            {error ? <div className="form-error">{error}</div> : null}
            <div className="modal-actions">
              <Button type="button" variant="secondary" onClick={() => setEditingKey(undefined)}>
                取消
              </Button>
              <Button type="submit" loading={loading}>
                保存
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
