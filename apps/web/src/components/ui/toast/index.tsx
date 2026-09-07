/**
 * @created 2026-08-26
 * @description 提供挂载于页面根节点的短暂操作反馈。
 * @author yunhungo
 */
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';

import { createPortal } from 'react-dom';

import './Toast.scss';

type ToastTone = 'success' | 'warning' | 'danger' | 'info';

const toastIcons = {
  success: CircleCheck,
  warning: CircleAlert,
  danger: CircleAlert,
  info: Info,
};

export function Toast({
  children,
  durationMs = 4_000,
  onDismiss,
  tone = 'info',
}: {
  children: ReactNode;
  durationMs?: number;
  onDismiss: () => void;
  tone?: ToastTone;
}) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, durationMs);
    return () => window.clearTimeout(timer);
  }, [durationMs, onDismiss]);

  const Icon = toastIcons[tone];

  return createPortal(
    <div className='toast-viewport'>
      <div className={`toast toast-${tone}`}>
        <Icon className='toast-icon' size={18} aria-hidden='true' />
        <div
          className='toast-content'
          role={tone === 'danger' ? 'alert' : 'status'}
          aria-atomic='true'
        >
          {children}
        </div>
        <button type='button' className='toast-close' onClick={onDismiss} aria-label='关闭提示'>
          <X size={16} aria-hidden='true' />
        </button>
      </div>
    </div>,
    document.body,
  );
}
