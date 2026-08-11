import { useState, type FormEvent } from 'react';
import { ArrowRight, LockKeyhole, Router } from 'lucide-react';

import { api, ApiError, jsonBody } from '../api';
import { BrandMark } from '../components/brand-mark';
import { Button, Field, Input } from '../components/ui';
import type { User } from '../types';

export function LoginPage({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const response = await api<{ user: User }>('/api/auth/login', {
        method: 'POST',
        ...jsonBody({ username, password }),
      });
      onLogin(response.user);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '登录失败，请稍后重试。');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-mesh" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div className="login-topbar">
        <BrandMark />
        <strong>xRouter</strong>
        <span>Self-hosted LLM gateway</span>
      </div>
      <div className="login-content">
        <section className="login-intro">
          <div className="eyebrow">
            <Router size={13} /> OpenAI-compatible gateway
          </div>
          <h1>一个入口，统一路由。</h1>
          <p>OAuth、API Key、用量与追踪。</p>
          <div className="protocol-row">
            <code>POST /v1/responses</code>
            <code>POST /v1/chat/completions</code>
          </div>
        </section>
        <section className="login-card">
          <div className="login-card-icon">
            <LockKeyhole size={19} />
          </div>
          <h2>登录控制平面</h2>
          <form onSubmit={(event) => void submit(event)}>
            <Field label="用户名">
              <Input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                required
              />
            </Field>
            <Field label="密码">
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                minLength={8}
                required
                autoFocus
              />
            </Field>
            {error ? <div className="form-error">{error}</div> : null}
            <Button type="submit" loading={loading} className="login-submit">
              进入后台 <ArrowRight size={15} />
            </Button>
          </form>
        </section>
      </div>
      <footer className="login-footer">
        <span>xRouter / v0.1.0</span>
        <span>PostgreSQL · Docker · Langfuse</span>
      </footer>
    </div>
  );
}
