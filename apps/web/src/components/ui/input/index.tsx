import type { InputHTMLAttributes } from 'react';

import './input.css';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="input" {...props} />;
}
