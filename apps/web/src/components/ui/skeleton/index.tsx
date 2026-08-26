import './skeleton.css';

export function Skeleton({ height = 120 }: { height?: number }) {
  return <div className="skeleton" style={{ height }} aria-label="加载中" />;
}
