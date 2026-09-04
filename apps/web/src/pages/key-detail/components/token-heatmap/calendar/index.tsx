import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, X } from 'lucide-react';
import { Button } from '../../../../../components/ui';
import type { KeyDailyUsageResponse } from '../../../../../types';
import { integer, money, type LogDrilldown } from '../../../key-detail-model';
import './calendar.css';
import { buildUsageCalendar, tokenLevel, usageDayRange, type UsageDay } from '../heatmap-model';

export function TokenHeatmapCalendar({
  data,
  onDrilldown,
}: {
  data: KeyDailyUsageResponse;
  onDrilldown: (drilldown: LogDrilldown) => void;
}) {
  const { days, cells, weeks } = useMemo(() => buildUsageCalendar(data.year, data.days), [data]);
  const [selected, setSelected] = useState<UsageDay>();
  const [hover, setHover] = useState<{
    day: UsageDay;
    left: number;
    top: number;
    above: boolean;
  }>();
  const [focusDay, setFocusDay] = useState(() => days.filter((day) => !day.future).at(-1)?.day);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const tooltipId = useId();
  const tooltipRef = useRef<HTMLDivElement>(null);
  const detailId = useId();
  const maxTokens = Math.max(0, ...days.map((day) => day.totalTokens));
  const totalTokens = days.reduce((sum, day) => sum + day.totalTokens, 0);
  const activeDays = days.filter((day) => day.calls > 0).length;

  useLayoutEffect(() => {
    if (!hover || !tooltipRef.current) return;
    const height = tooltipRef.current.getBoundingClientRect().height;
    const top = hover.above ? hover.top - height : hover.top;
    tooltipRef.current.style.top = `${Math.max(12, Math.min(top, window.innerHeight - height - 12))}px`;
  }, [hover]);

  useEffect(() => {
    const dismiss = () => setHover(undefined);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, []);

  const showTooltip = (day: UsageDay, element: HTMLButtonElement) => {
    const rect = element.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 24);
    const above = rect.top > 300;
    setHover({
      day,
      above,
      left: Math.max(
        12,
        Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 12),
      ),
      top: above ? rect.top - 10 : rect.bottom + 10,
    });
  };

  const navigateDay = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'Escape') {
      setHover(undefined);
      return;
    }
    const offsets: Record<string, number> = {
      ArrowUp: -1,
      ArrowDown: 1,
      ArrowLeft: -7,
      ArrowRight: 7,
    };
    const offset = offsets[event.key];
    if (offset === undefined && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const target =
      event.key === 'Home'
        ? days[0]
        : event.key === 'End'
          ? days.filter((day) => !day.future).at(-1)
          : cells[index + (offset ?? 0)];
    if (target && !target.future) buttons.current.get(target.day)?.focus();
  };

  const openLogs = (day: UsageDay, model?: UsageDay['models'][number]) => {
    onDrilldown({
      label: `${day.day} · ${model ? model.model : '当天调用'}`,
      metric: 'recent',
      ...usageDayRange(day),
      ...(model ? { model: model.model, provider: model.provider } : {}),
    });
  };

  return (
    <>
      <div className="token-heatmap-body">
        <div className="token-heatmap-summary">
          <span>
            <strong>{integer.format(totalTokens)}</strong> Token{' '}
            <span className="token-heatmap-muted">· {activeDays} 天有调用</span>
          </span>
          <span className="token-heatmap-muted">悬停查看用量，点击查看当天详情</span>
        </div>
        <div className="token-heatmap-scroll">
          <div
            className="token-heatmap-calendar"
            style={{ '--heatmap-weeks': weeks } as CSSProperties}
          >
            <div className="token-heatmap-months" aria-hidden="true">
              {Array.from({ length: 12 }, (_, month) => {
                const index = cells.findIndex((day) => day?.date.getMonth() === month);
                return (
                  <span key={month} style={{ gridColumn: Math.floor(index / 7) + 1 }}>
                    {month + 1} 月
                  </span>
                );
              })}
            </div>
            <div className="token-heatmap-weekdays" aria-hidden="true">
              {['一', '', '三', '', '五', '', '日'].map((label, index) => (
                <span key={index}>{label}</span>
              ))}
            </div>
            <div
              className="token-heatmap-cells"
              role="group"
              aria-label={`${data.year} 年每日用量，可用方向键选择日期`}
            >
              {cells.map((day, index) =>
                day ? (
                  <button
                    key={day.day}
                    type="button"
                    ref={(element) => {
                      if (element) buttons.current.set(day.day, element);
                      else buttons.current.delete(day.day);
                    }}
                    className={`token-heatmap-cell token-level-${tokenLevel(day.totalTokens, maxTokens)}`}
                    disabled={day.future}
                    tabIndex={day.day === focusDay ? 0 : -1}
                    aria-label={`${day.day}，${integer.format(day.totalTokens)} Token，${day.calls} 次调用${day.future ? '，未来日期' : ''}`}
                    aria-pressed={selected?.day === day.day}
                    aria-controls={selected?.day === day.day ? detailId : undefined}
                    aria-describedby={hover?.day.day === day.day ? tooltipId : undefined}
                    data-day={day.day}
                    onMouseEnter={(event) => showTooltip(day, event.currentTarget)}
                    onMouseLeave={() => setHover(undefined)}
                    onFocus={(event) => {
                      setFocusDay(day.day);
                      showTooltip(day, event.currentTarget);
                    }}
                    onBlur={() => setHover(undefined)}
                    onKeyDown={(event) => navigateDay(event, index)}
                    onClick={() => {
                      setSelected(day);
                      setHover(undefined);
                    }}
                  />
                ) : (
                  <span key={`pad-${index}`} />
                ),
              )}
            </div>
          </div>
        </div>
        <div className="token-heatmap-footer">
          <span>
            {data.timeZone} · 每格一天{!activeDays ? ' · 本年暂无调用数据' : ''}
          </span>
          <div
            className="token-heatmap-legend"
            aria-label={`颜色越深，Token 越多，最高 ${integer.format(maxTokens)} Token`}
          >
            <span>少</span>
            {[0, 1, 2, 3, 4].map((level) => (
              <i key={level} className={`token-level-${level}`} />
            ))}
            <span>多</span>
          </div>
        </div>
      </div>
      {selected ? (
        <div
          className="token-heatmap-detail"
          id={detailId}
          role="region"
          aria-label={`${selected.day} 用量详情`}
        >
          <div className="token-heatmap-detail-heading">
            <div>
              <h3>{selected.day}</h3>
              <span>
                {selected.calls
                  ? `${selected.models.length} 个模型 · ${selected.calls} 次调用 · ${selected.failedCalls} 次失败`
                  : '当天暂无调用'}
              </span>
            </div>
            <div className="token-heatmap-detail-actions">
              <Button variant="secondary" onClick={() => openLogs(selected)}>
                查看当天调用 <ArrowRight size={13} />
              </Button>
              <Button
                variant="ghost"
                aria-label="收起当天详情"
                onClick={() => {
                  setSelected(undefined);
                  buttons.current.get(selected.day)?.focus();
                  setHover(undefined);
                }}
              >
                <X size={15} />
              </Button>
            </div>
          </div>
          <div className="token-heatmap-day-total">
            <strong>{integer.format(selected.totalTokens)}</strong> Token{' '}
            <span>· {money.format(selected.costUsd)}</span>
          </div>
          {selected.models.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>模型 / Provider</th>
                    <th>Token</th>
                    <th>输入 / 输出</th>
                    <th>缓存 / 推理</th>
                    <th>调用 / 失败</th>
                    <th>成本</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.models.map((model) => (
                    <tr key={JSON.stringify([model.provider, model.model])}>
                      <td>
                        <button
                          type="button"
                          className="token-heatmap-model-link"
                          onClick={() => openLogs(selected, model)}
                          aria-label={`查看 ${model.model} · ${model.provider} 当天调用`}
                        >
                          <span>{model.model}</span>
                          <ArrowRight size={12} />
                        </button>
                        <small>{model.provider}</small>
                      </td>
                      <td data-label="Token">{integer.format(model.totalTokens)}</td>
                      <td data-label="输入 / 输出">
                        {integer.format(model.inputTokens)}
                        <small>{integer.format(model.outputTokens)} output</small>
                      </td>
                      <td data-label="缓存 / 推理">
                        {integer.format(model.cachedInputTokens)}
                        <small>{integer.format(model.reasoningTokens)} reasoning</small>
                      </td>
                      <td data-label="调用 / 失败">
                        {integer.format(model.calls)}
                        <small>{integer.format(model.failedCalls)} 次失败</small>
                      </td>
                      <td data-label="成本">{money.format(model.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
      {hover
        ? createPortal(
            <div
              id={tooltipId}
              ref={tooltipRef}
              role="tooltip"
              className="token-heatmap-tooltip"
              style={{
                left: hover.left,
                top: hover.top,
              }}
            >
              <strong>{hover.day.day}</strong>
              <div className="token-heatmap-tooltip-total">
                {integer.format(hover.day.totalTokens)} <span>Token</span>
              </div>
              <p>
                {hover.day.calls
                  ? `${hover.day.calls} 次调用 · ${hover.day.failedCalls} 次失败`
                  : '当天暂无调用'}
              </p>
              {hover.day.models.slice(0, 5).map((model) => (
                <div
                  className="token-heatmap-tooltip-model"
                  key={JSON.stringify([model.provider, model.model])}
                >
                  <span>
                    {model.model}
                    <small>{model.provider}</small>
                  </span>
                  <strong>{integer.format(model.totalTokens)}</strong>
                </div>
              ))}
              <small>
                {hover.day.models.length > 5
                  ? `共 ${hover.day.models.length} 个模型，点击查看全部`
                  : '点击查看当天详情'}
              </small>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
