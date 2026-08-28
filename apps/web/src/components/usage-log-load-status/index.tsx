import { Button } from '../ui';
import './usage-log-load-status.css';

export function UsageLogLoadStatus({
  loading,
  error,
  hasMore,
  count,
  onRetry,
}: {
  loading: boolean;
  error: string;
  hasMore: boolean;
  count: number;
  onRetry: () => void;
}) {
  if (!count || (!loading && !error && hasMore)) return null;
  return (
    <div
      className={`usage-load-status${error ? ' error' : ''}`}
      role={error ? 'alert' : 'status'}
      aria-live={error ? 'assertive' : 'polite'}
    >
      {loading ? '正在加载下一批调用记录…' : null}
      {error ? (
        <>
          <span>{error}</span>
          <Button variant="secondary" onClick={onRetry}>
            重试
          </Button>
        </>
      ) : null}
      {!loading && !error && !hasMore ? `已加载全部 ${count} 条调用记录。` : null}
    </div>
  );
}
