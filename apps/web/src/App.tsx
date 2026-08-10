import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { api } from './api';
import { AppLayout } from './components/layout';
import { DashboardPage } from './pages/dashboard';
import { KeysPage } from './pages/keys';
import { LoginPage } from './pages/login';
import { ProvidersPage } from './pages/providers';
import { SettingsPage } from './pages/settings';
import { UsagePage } from './pages/usage';
import type { User } from './types';

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  const refreshSession = useCallback(async () => {
    try {
      const response = await api<{ user: User }>('/api/auth/me');
      setUser(response.user);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => void refreshSession(), [refreshSession]);

  if (user === undefined) {
    return (
      <div className="boot-screen">
        <div className="brand-mark large">
          <span />
          <span />
        </div>
        <span>正在连接控制平面…</span>
      </div>
    );
  }
  if (!user) return <LoginPage onLogin={setUser} />;

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    setUser(null);
  };

  return (
    <AppLayout user={user} onLogout={() => void logout()}>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/providers" element={<ProvidersPage />} />
        <Route path="/keys" element={<KeysPage />} />
        <Route path="/usage" element={<UsagePage />} />
        <Route
          path="/settings"
          element={<SettingsPage user={user} onAccountChanged={() => setUser(null)} />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppLayout>
  );
}
