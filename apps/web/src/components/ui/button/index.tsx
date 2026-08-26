import { LoaderCircle } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';

import './button.css';

export function Button({
  children,
  variant = 'primary',
  loading = false,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  loading?: boolean;
}) {
  return (
    <button
      {...props}
      className={`button button-${variant} ${className}`}
      disabled={loading || props.disabled}
    >
      {loading ? <LoaderCircle size={15} className="spin" /> : null}
      {children}
    </button>
  );
}
