import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-react';

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
import type { Provider, VirtualKey } from '../types';

interface CreatedKey {
  id: string;
  rawKey: string;
  prefix: string;
  warning: string;
}

export function KeysPage() {
  const [keys, setKeys] = useState<VirtualKey[]>();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [created, setCreated] = useState<CreatedKey>();
  const [name, setName] = useState('Development');
  const [rpm, setRpm] = useState(60);
  const [budget, setBudget] = useState('');
  const [providerId, setProviderId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
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
  const revoke = async (key: VirtualKey) => {
    if (!window.confirm(`撤销“${key.name}”？使用该 Key 的请求会立即失败。`)) return;
    await api(`/api/admin/keys/${key.id}/revoke`, { method: 'POST' });
    await load();
  };

  return (
    <div className="page-wrap">
      <PageHeader
        eyebrow="Virtual keys"
        title="API Keys。"
        description="为客户端签发独立 Key，设置 RPM、预算和固定上游连接。"
        action={
          <Button
            onClick={() => {
              setShowCreate(true);
              setCreated(undefined);
              setError('');
            }}
          >
            <Plus size={14} /> 创建 Key
          </Button>
        }
      />
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
                  <th>状态</th>
                  <th>上游</th>
                  <th>RPM</th>
                  <th>预算 / 已用</th>
                  <th>最近调用</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id}>
                    <td>
                      <strong>{key.name}</strong>
                      <small>{new Date(key.createdAt).toLocaleDateString('zh-CN')} 创建</small>
                    </td>
                    <td>
                      <code>{key.keyPrefix}</code>
                    </td>
                    <td>
                      <Badge tone={key.status === 'active' ? 'success' : 'neutral'}>
                        {key.status === 'active' ? 'Active' : 'Revoked'}
                      </Badge>
                    </td>
                    <td>{key.providerName ?? '自动路由'}</td>
                    <td>{key.rpmLimit.toLocaleString()}</td>
                    <td>
                      {key.budgetUsd === null ? 'Unlimited' : `$${key.budgetUsd.toFixed(2)}`}
                      <small>${key.spendUsd.toFixed(4)} spent</small>
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
                      <button
                        className="icon-button danger-icon"
                        disabled={key.status !== 'active'}
                        onClick={() => void revoke(key)}
                        aria-label="撤销"
                      >
                        <Trash2 size={15} />
                      </button>
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
          description="创建第一个虚拟 Key 后，客户端就能通过 OpenAI 兼容接口访问网关。"
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
              <p>{created.warning}</p>
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
                <ShieldCheck size={14} /> 关闭窗口后无法再次查看完整 Key。
              </div>
              <div className="modal-actions">
                <Button
                  onClick={() => {
                    setShowCreate(false);
                    setCreated(undefined);
                  }}
                >
                  我已保存
                </Button>
              </div>
            </div>
          ) : (
            <form className="modal-body" onSubmit={(event) => void create(event)}>
              <Field label="名称">
                <Input value={name} onChange={(event) => setName(event.target.value)} required />
              </Field>
              <div className="form-grid">
                <Field label="每分钟请求数">
                  <Input
                    type="number"
                    min={1}
                    max={100000}
                    value={rpm}
                    onChange={(event) => setRpm(Number(event.target.value))}
                    required
                  />
                </Field>
                <Field label="预算 USD（可选）">
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
              <Field label="固定上游（可选）" hint="留空时按连接优先级自动路由。">
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
              {error ? <div className="form-error">{error}</div> : null}
              <div className="modal-actions">
                <Button type="button" variant="secondary" onClick={() => setShowCreate(false)}>
                  取消
                </Button>
                <Button type="submit" loading={loading}>
                  创建 Key
                </Button>
              </div>
            </form>
          )}
        </Modal>
      ) : null}
    </div>
  );
}
