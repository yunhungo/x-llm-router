import { useState, type ReactNode } from 'react';
import {
  Activity,
  Cable,
  ChartNoAxesCombined,
  ChevronLeft,
  KeyRound,
  LogOut,
  Menu,
  Settings,
  X,
} from 'lucide-react';
import { NavLink } from 'react-router-dom';

import type { User } from '../types';

const navigation = [
  { to: '/', label: '概览', icon: ChartNoAxesCombined, end: true },
  { to: '/providers', label: '上游连接', icon: Cable },
  { to: '/keys', label: 'API Keys', icon: KeyRound },
  { to: '/usage', label: '调用记录', icon: Activity },
  { to: '/settings', label: '平台设置', icon: Settings },
];

export function AppLayout({
  user,
  children,
  onLogout,
}: {
  user: User;
  children: ReactNode;
  onLogout: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <div className={`app-shell ${collapsed ? 'is-collapsed' : ''}`}>
      <aside className={`sidebar ${mobileOpen ? 'is-open' : ''}`}>
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
          </div>
          <div className="brand-copy">
            <strong>xRouter</strong>
            <span>Control plane</span>
          </div>
          <button
            className="icon-button mobile-close"
            onClick={() => setMobileOpen(false)}
            aria-label="关闭菜单"
          >
            <X size={16} />
          </button>
        </div>
        <div className="nav-label">Workspace</div>
        <nav className="side-nav">
          {navigation.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              {...(end ? { end: true } : {})}
              onClick={() => setMobileOpen(false)}
            >
              <Icon size={16} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="user-avatar">{user.username.slice(0, 1).toUpperCase()}</div>
          <div className="user-copy">
            <strong>{user.username}</strong>
            <span>Administrator</span>
          </div>
          <button className="icon-button" onClick={onLogout} aria-label="退出登录" title="退出登录">
            <LogOut size={15} />
          </button>
        </div>
        <button
          className="collapse-button"
          onClick={() => setCollapsed((value) => !value)}
          aria-label="收起侧栏"
        >
          <ChevronLeft size={15} />
        </button>
      </aside>
      <div className="app-main">
        <header className="mobile-header">
          <button className="icon-button" onClick={() => setMobileOpen(true)} aria-label="打开菜单">
            <Menu size={18} />
          </button>
          <strong>xRouter</strong>
          <span className="live-dot">
            <i /> Online
          </span>
        </header>
        <main>{children}</main>
      </div>
      {mobileOpen ? (
        <button
          className="mobile-overlay"
          onClick={() => setMobileOpen(false)}
          aria-label="关闭菜单遮罩"
        />
      ) : null}
    </div>
  );
}
