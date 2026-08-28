import type { KeyAnalyticsRange } from '../../../../types';
import './range-switch.css';

export function RangeSwitch({
  value,
  onChange,
}: {
  value: KeyAnalyticsRange;
  onChange: (range: KeyAnalyticsRange) => void;
}) {
  return (
    <div className="range-switch" aria-label="统计范围">
      {(
        [
          ['24h', '天'],
          ['7d', '周'],
          ['30d', '月'],
        ] as const
      ).map(([range, label]) => (
        <button
          type="button"
          key={range}
          className={value === range ? 'active' : ''}
          onClick={() => onChange(range)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
