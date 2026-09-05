/**
 * @created 2026-09-05
 * @description 展示调用的输出速度与两种首输出时间。
 * @author yunhungo
 */
import './UsageLogPerformance.scss';

interface UsageLogPerformanceProps {
  tps: number | null;
  timeToFirstTokenMs: number | null;
  timeToFirstVisibleTokenMs: number | null;
}

const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function UsageLogPerformance({
  tps,
  timeToFirstTokenMs,
  timeToFirstVisibleTokenMs,
}: UsageLogPerformanceProps) {
  const metrics = [
    {
      label: 'TPS',
      hint: '含推理',
      description:
        '输出 token（含 reasoning）÷ 首个输出事件到请求结束的秒数。隐藏推理未返回时，此值可能偏高。',
      value: tps,
      unit: 'tok/s',
      formatter: decimal,
    },
    {
      label: 'TTFT',
      hint: '首 Token',
      description:
        '从请求开始到网关收到首个输出事件，包括 reasoning、正文或工具调用。隐藏推理的开始时间无法观测。',
      value: timeToFirstTokenMs,
      unit: 'ms',
      formatter: integer,
    },
    {
      label: 'TTFO',
      hint: '首输出',
      description:
        '从请求开始到网关收到首个非 reasoning 输出（正文或工具调用）。不含思考内容；隐藏推理时可能与 TTFT 相同。',
      value: timeToFirstVisibleTokenMs,
      unit: 'ms',
      formatter: integer,
    },
  ];

  return (
    <dl className='usage-log-performance' aria-label='输出性能'>
      {metrics.map(({ label, hint, description, value, unit, formatter }) => (
        <div className='usage-log-performance__metric' key={label}>
          <dt title={description} tabIndex={0} aria-label={`${label}：${description}`}>
            <span className='usage-log-performance__label'>{label}</span>
            <span className='usage-log-performance__hint'>{hint}</span>
          </dt>
          <dd title={value == null ? '未采集到此指标' : undefined}>
            {value == null ? (
              '—'
            ) : (
              <>
                {formatter.format(value)}{' '}
                <span className='usage-log-performance__unit'>{unit}</span>
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
