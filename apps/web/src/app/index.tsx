import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { api } from '../api';
import { AppLayout } from '../components/app-layout';
import { BrandMark } from '../components/brand-mark';
import { LoginPage } from '../pages/login';
import type { User } from '../types';
import './app.css';

const DashboardPage = lazy(() =>
  import('../pages/dashboard').then((module) => ({ default: module.DashboardPage })),
);
const ProvidersPage = lazy(() =>
  import('../pages/providers').then((module) => ({ default: module.ProvidersPage })),
);
const KeysPage = lazy(() =>
  import('../pages/keys').then((module) => ({ default: module.KeysPage })),
);
const KeyDetailPage = lazy(() =>
  import('../pages/key-detail').then((module) => ({ default: module.KeyDetailPage })),
);
const UsagePage = lazy(() =>
  import('../pages/usage').then((module) => ({ default: module.UsagePage })),
);
const SettingsPage = lazy(() =>
  import('../pages/settings').then((module) => ({ default: module.SettingsPage })),
);
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
        <BrandMark large />
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
      <Suspense
        fallback={
          <div className="page-wrap">
            <BrandMark large />
          </div>
        }
      >
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/providers" element={<ProvidersPage />} />
          <Route path="/keys" element={<KeysPage />} />
          <Route path="/keys/:id" element={<KeyDetailPage />} />
          <Route path="/usage" element={<UsagePage />} />
          <Route
            path="/settings"
            element={<SettingsPage user={user} onAccountChanged={() => setUser(null)} />}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </AppLayout>
  );
}
