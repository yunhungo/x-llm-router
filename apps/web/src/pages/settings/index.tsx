import { useState, type FormEvent } from 'react';
import { LockKeyhole } from 'lucide-react';

import { api, ApiError, jsonBody } from '../../api';
import { Button, Field, Input, PageHeader } from '../../components/ui';
import type { User } from '../../types';
import './settings.css';

export function SettingsPage({
  user,
  onAccountChanged,
}: {
  user: User;
  onAccountChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newUsername, setNewUsername] = useState(user.username);
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');

  const updateAccount = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      await api('/api/auth/account', {
        method: 'PATCH',
        ...jsonBody({ currentPassword, newUsername, newPassword }),
      });
      onAccountChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '更新失败。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page-wrap">
      <PageHeader title="平台设置" />
      <div className="settings-grid single">
        <section className="panel settings-panel">
          <div className="panel-heading">
            <div className="settings-title">
              <div className="settings-icon">
                <LockKeyhole size={18} />
              </div>
              <h2>修改账户</h2>
            </div>
          </div>
          <form onSubmit={(event) => void updateAccount(event)}>
            <Field label="用户名">
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
            <Field label="新密码" hint="至少 12 位">
              <Input
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                autoComplete="new-password"
                minLength={12}
                required
              />
            </Field>
            {error ? <div className="form-error">{error}</div> : null}
            <div className="panel-actions end">
              <Button type="submit" loading={saving}>
                保存
              </Button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
