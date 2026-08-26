import { CircleHelp } from 'lucide-react';
import type { ReactNode } from 'react';

import './field.css';

export function Field({
  label,
  helpText,
  hint,
  children,
}: {
  label: string;
  helpText?: string;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {helpText ? (
          <span className="field-help" tabIndex={0} aria-label={helpText}>
            <CircleHelp size={14} aria-hidden="true" />
            <span className="field-help-tooltip" role="tooltip">
              {helpText}
            </span>
          </span>
        ) : null}
      </span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}
