import { LoaderCircle } from 'lucide-react';

import type { UsageLog } from '../../types';
import { Badge } from '../ui';
import './usage-log-status.css';

const statusPresentation: Record<
  UsageLog['callStatus'],
  { label: string; tone: 'blue' | 'warning' | 'success' | 'danger' }
> = {
  processing: { label: 'Processing', tone: 'blue' },
  thinking: { label: 'Thinking', tone: 'warning' },
  responding: { label: 'Generating', tone: 'blue' },
  completed: { label: 'Succeeded', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
};

export function isUsageLogActive(callStatus: UsageLog['callStatus']): boolean {
  return callStatus === 'processing' || callStatus === 'thinking' || callStatus === 'responding';
}

export function UsageLogStatusBadge({
  callStatus,
  statusCode,
}: Pick<UsageLog, 'callStatus' | 'statusCode'>) {
  const presentation = statusPresentation[callStatus];
  const active = isUsageLogActive(callStatus);
  return (
    <span role="status" aria-label={`Call status: ${presentation.label}`}>
      <Badge tone={presentation.tone}>
        {active ? <LoaderCircle className="usage-status-spinner" size={12} aria-hidden /> : null}
        {presentation.label}
        {!active && statusCode !== null ? ` · ${statusCode}` : ''}
      </Badge>
    </span>
  );
}
