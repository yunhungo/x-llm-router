import { useEffect, useState, type FormEvent } from 'react';
import { CircleAlert, ExternalLink, Eye, EyeOff, LockKeyhole, Save, Waypoints } from 'lucide-react';

import { api, ApiError, jsonBody } from '../api';
import { Badge, Button, Field, Input, PageHeader, Skeleton } from '../components/ui';
import type { User } from '../types';

interface LangfuseSettings {
  enabled: boolean;
  publicKey: string;
  hasSecretKey: boolean;
  baseUrl: string;
  environment: string;
  captureInput: boolean;
  captureOutput: boolean;
  restartRequiredAfterSave: boolean;
}

export function SettingsPage({
  user,
  onAccountChanged,
}: {
  user: User;
  onAccountChanged: () => void;
}) {
  const [settings, setSettings] = useState<LangfuseSettings>();
  const [secretKey, setSecretKey] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newUsername, setNewUsername] = useState(user.username);
  const [newPassword, setNewPassword] = useState('');
  const [accountError, setAccountError] = useState('');

  useEffect(() => {
    void api<{ settings: LangfuseSettings }>('/api/admin/settings/langfuse').then((response) =>
      setSettings(response.settings),
    );
  }, []);

  const saveLangfuse = async (event: FormEvent) => {
    event.preventDefault();
    if (!settings) return;
    setSaving(true);
    setNotice('');
    try {
      await api('/api/admin/settings/langfuse', {
        method: 'PUT',
        ...jsonBody({
          enabled: settings.enabled,
          publicKey: settings.publicKey,
          secretKey: secretKey || undefined,
          baseUrl: settings.baseUrl,
          environment: settings.environment,
          captureInput: settings.captureInput,
          captureOutput: settings.captureOutput,
        }),
      });
      setSecretKey('');
      setNotice('Langfuse 设置已保存。重启 API 服务后应用新的导出器配置。');
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : '保存失败。');
    } finally {
      setSaving(false);
    }
  };

  const updateAccount = async (event: FormEvent) => {
    event.preventDefault();
    setAccountError('');
    setSaving(true);
    try {
      await api('/api/auth/account', {
        method: 'PATCH',
        ...jsonBody({ currentPassword, newUsername, newPassword }),
      });
      onAccountChanged();
    } catch (error) {
      setAccountError(error instanceof ApiError ? error.message : '更新失败。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page-wrap">
      <PageHeader
        eyebrow="Platform configuration"
        title="平台设置。"
        description="配置 Langfuse 可观测性、数据采集边界与管理员凭据。"
      />
      <div className="settings-grid">
        <section className="panel settings-panel">
          <div className="panel-heading">
            <div className="settings-title">
              <div className="settings-icon">
                <Waypoints size={18} />
              </div>
              <div>
                <h2>Langfuse</h2>
                <p>将每次路由请求导出为 generation observation。</p>
              </div>
            </div>
            {settings?.enabled ? <Badge tone="success">Enabled</Badge> : <Badge>Disabled</Badge>}
          </div>
          {!settings ? (
            <Skeleton height={300} />
          ) : (
            <form onSubmit={(event) => void saveLangfuse(event)}>
              <label className="switch-row">
                <div>
                  <strong>启用追踪</strong>
                  <span>需要有效的 Public / Secret Key。</span>
                </div>
                <input
                  type="checkbox"
                  checked={settings.enabled}
                  onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })}
                />
                <i />
              </label>
              <div className="form-grid">
                <Field label="Public Key">
                  <Input
                    value={settings.publicKey}
                    onChange={(event) =>
                      setSettings({ ...settings, publicKey: event.target.value })
                    }
                    placeholder="pk-lf-…"
                  />
                </Field>
                <Field
                  label="Secret Key"
                  hint={settings.hasSecretKey ? '已保存；留空保持不变。' : '尚未配置。'}
                >
                  <div className="input-action">
                    <Input
                      type={showSecret ? 'text' : 'password'}
                      value={secretKey}
                      onChange={(event) => setSecretKey(event.target.value)}
                      placeholder={settings.hasSecretKey ? '••••••••••••' : 'sk-lf-…'}
                    />
                    <button type="button" onClick={() => setShowSecret((value) => !value)}>
                      {showSecret ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </Field>
              </div>
              <Field label="Langfuse Base URL">
                <Input
                  type="url"
                  value={settings.baseUrl}
                  onChange={(event) => setSettings({ ...settings, baseUrl: event.target.value })}
                />
              </Field>
              <Field label="Environment">
                <Input
                  value={settings.environment}
                  onChange={(event) =>
                    setSettings({ ...settings, environment: event.target.value })
                  }
                />
              </Field>
              <div className="capture-options">
                <label>
                  <input
                    type="checkbox"
                    checked={settings.captureInput}
                    onChange={(event) =>
                      setSettings({ ...settings, captureInput: event.target.checked })
                    }
                  />
                  <span>
                    <strong>记录输入内容</strong>
                    <small>可能包含用户提示词或敏感信息。</small>
                  </span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={settings.captureOutput}
                    onChange={(event) =>
                      setSettings({ ...settings, captureOutput: event.target.checked })
                    }
                  />
                  <span>
                    <strong>记录输出内容</strong>
                    <small>关闭时只记录状态、Token 与成本。</small>
                  </span>
                </label>
              </div>
              <div className="settings-warning">
                <CircleAlert size={14} /> 导出器在服务启动时初始化；修改连接配置后需重启 API 容器。
              </div>
              {notice ? <div className="notice success">{notice}</div> : null}
              <div className="panel-actions">
                <a
                  className="inline-link"
                  href="https://langfuse.com/docs/observability/get-started"
                  target="_blank"
                  rel="noreferrer"
                >
                  配置文档 <ExternalLink size={13} />
                </a>
                <Button type="submit" loading={saving}>
                  <Save size={14} /> 保存设置
                </Button>
              </div>
            </form>
          )}
        </section>
        <section className="panel settings-panel">
          <div className="panel-heading">
            <div className="settings-title">
              <div className="settings-icon">
                <LockKeyhole size={18} />
              </div>
              <div>
                <h2>管理员账户</h2>
                <p>修改登录名和密码后会退出当前会话。</p>
              </div>
            </div>
          </div>
          <form onSubmit={(event) => void updateAccount(event)}>
            <Field label="新用户名">
              <Input
                value={newUsername}
                onChange={(event) => setNewUsername(event.target.value)}
                required
              />
            </Field>
            <Field label="当前密码">
              <Input
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>
            <Field label="新密码" hint="至少 12 位，建议使用密码管理器生成。">
              <Input
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                autoComplete="new-password"
                minLength={12}
                required
              />
            </Field>
            {accountError ? <div className="form-error">{accountError}</div> : null}
            <div className="panel-actions end">
              <Button type="submit" loading={saving}>
                更新账户
              </Button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
