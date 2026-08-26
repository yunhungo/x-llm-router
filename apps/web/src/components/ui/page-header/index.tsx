import type { ReactNode } from 'react';

import './page-header.css';

export function PageHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <header className="page-header">
      <h1>{title}</h1>
      {action ? <div className="page-action">{action}</div> : null}
    </header>
  );
}
