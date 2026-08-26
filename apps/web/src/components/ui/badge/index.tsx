import type { ReactNode } from 'react';

import './badge.css';

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'blue';
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
