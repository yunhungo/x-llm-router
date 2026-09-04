import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  dateRangeError,
  calendarDateRange,
  relativeDateRange,
  type DateRange,
} from '../../date-range';
import { Button } from '../ui';
import './date-range-picker.css';

export interface DateRangePreset {
  label: string;
  days: number;
}

export interface DateRangePickerProps {
  value: DateRange;
  onApply: (range: DateRange) => void;
  label?: string | undefined;
  ariaLabel?: string;
  className?: string;
  align?: 'start' | 'end';
  presets?: readonly DateRangePreset[];
}

const defaultPresets: readonly DateRangePreset[] = [
  { label: '24 小时', days: 1 },
  { label: '7 天', days: 7 },
  { label: '30 天', days: 30 },
];

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const monthFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
});
const weekdays = ['一', '二', '三', '四', '五', '六', '日'];

function localDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function displayRangeEnd(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return date;
  return date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0
    ? new Date(date.getTime() - 1)
    : date;
}

export function calendarMonthDays(month: Date) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const mondayOffset = (first.getDay() + 6) % 7;
  const firstCell = new Date(first.getFullYear(), first.getMonth(), 1 - mondayOffset);
  return Array.from(
    { length: 42 },
    (_, index) =>
      new Date(firstCell.getFullYear(), firstCell.getMonth(), firstCell.getDate() + index),
  );
}

function dayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatRangeValue(value: string, end = false) {
  const date = end ? displayRangeEnd(value) : new Date(value);
  return Number.isFinite(date.getTime()) ? dateFormatter.format(date) : '未选择';
}

function RangeCalendar({
  month,
  range,
  onSelect,
  onPrevious,
  onNext,
}: {
  month: Date;
  range: DateRange;
  onSelect: (date: Date) => void;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const from = range.from ? localDay(new Date(range.from)) : undefined;
  const to = range.to ? localDay(displayRangeEnd(range.to)) : undefined;
  const today = localDay(new Date());

  return (
    <section className="date-range-calendar">
      <header>
        {onPrevious ? (
          <button type="button" onClick={onPrevious} aria-label="上一个月">
            <ChevronLeft size={15} />
          </button>
        ) : (
          <span />
        )}
        <strong>{monthFormatter.format(month)}</strong>
        {onNext ? (
          <button type="button" onClick={onNext} aria-label="下一个月">
            <ChevronRight size={15} />
          </button>
        ) : (
          <span />
        )}
      </header>
      <div className="date-range-weekdays" aria-hidden="true">
        {weekdays.map((weekday) => (
          <span key={weekday}>{weekday}</span>
        ))}
      </div>
      <div className="date-range-days">
        {calendarMonthDays(month).map((day) => {
          const time = localDay(day).getTime();
          const isStart = from?.getTime() === time;
          const isEnd = to?.getTime() === time;
          const inRange = Boolean(from && to && time > from.getTime() && time < to.getTime());
          const outside = day.getMonth() !== month.getMonth();
          const current = today.getTime() === time;
          return (
            <button
              type="button"
              key={dayKey(day)}
              className={[
                outside ? 'outside' : '',
                inRange ? 'in-range' : '',
                isStart ? 'range-start' : '',
                isEnd ? 'range-end' : '',
                current ? 'today' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-label={dateFormatter.format(day)}
              aria-pressed={isStart || isEnd}
              onClick={() => onSelect(day)}
            >
              {day.getDate()}
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function DateRangePicker({
  value,
  onApply,
  label,
  ariaLabel = '选择日期区间',
  className = '',
  align = 'start',
  presets = defaultPresets,
}: DateRangePickerProps) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [selectingEnd, setSelectingEnd] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => {
    const date = new Date(value.from);
    return Number.isFinite(date.getTime())
      ? new Date(date.getFullYear(), date.getMonth(), 1)
      : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  });
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const rangeError = dateRangeError(draft);

  const updatePosition = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const panelWidth = Math.min(640, window.innerWidth - 24);
    const panelHeight = panelRef.current?.offsetHeight ?? 430;
    const left = Math.min(
      Math.max(12, align === 'end' ? rect.right - panelWidth : rect.left),
      Math.max(12, window.innerWidth - panelWidth - 12),
    );
    const below = rect.bottom + 7;
    const top =
      below + panelHeight <= window.innerHeight - 12
        ? below
        : Math.max(12, rect.top - panelHeight - 7);
    setPosition({ top, left });
  };

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, align]);

  useEffect(() => {
    if (open) {
      const panel = panelRef.current;
      const firstDate = panel?.querySelector<HTMLButtonElement>(
        '.date-range-days button[aria-pressed="true"], .date-range-days button:not(.outside)',
      );
      firstDate?.focus({ preventScroll: true });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const openPicker = () => {
    const from = new Date(value.from);
    setDraft(value);
    setSelectingEnd(false);
    if (Number.isFinite(from.getTime())) {
      setVisibleMonth(new Date(from.getFullYear(), from.getMonth(), 1));
    }
    setOpen(true);
  };

  const selectDay = (day: Date) => {
    const selected = localDay(day);
    if (!selectingEnd || !draft.from) {
      setDraft({ from: selected.toISOString(), to: '' });
      setSelectingEnd(true);
      return;
    }
    setDraft(calendarDateRange(new Date(draft.from), selected));
    setSelectingEnd(false);
  };

  const selectPreset = (days: number) => {
    const preset = relativeDateRange(days);
    const from = new Date(preset.from);
    setDraft(preset);
    setVisibleMonth(new Date(from.getFullYear(), from.getMonth(), 1));
    setSelectingEnd(false);
  };

  const nextMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1);
  const canApply = !rangeError && !selectingEnd;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`date-range-trigger ${className}`.trim()}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? setOpen(false) : openPicker())}
      >
        <CalendarDays size={14} />
        <span>
          {label ?? (
            <>
              {formatRangeValue(value.from)} <i>—</i> {formatRangeValue(value.to, true)}
            </>
          )}
        </span>
        <ChevronDown size={13} />
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              className="date-range-popover"
              role="dialog"
              aria-label={ariaLabel}
              style={position}
            >
              <div className="date-range-heading">
                <strong>日期区间</strong>
                <span>{selectingEnd ? '请选择结束日期' : '点击日期重新选择区间'}</span>
              </div>
              <div className="date-range-calendars">
                <RangeCalendar
                  month={visibleMonth}
                  range={draft}
                  onSelect={selectDay}
                  onPrevious={() =>
                    setVisibleMonth(
                      (current) => new Date(current.getFullYear(), current.getMonth() - 1, 1),
                    )
                  }
                  onNext={() =>
                    setVisibleMonth(
                      (current) => new Date(current.getFullYear(), current.getMonth() + 1, 1),
                    )
                  }
                />
                <RangeCalendar
                  month={nextMonth}
                  range={draft}
                  onSelect={selectDay}
                  onNext={() =>
                    setVisibleMonth(
                      (current) => new Date(current.getFullYear(), current.getMonth() + 1, 1),
                    )
                  }
                />
              </div>
              <div className="date-range-footer">
                <div className="date-range-presets" aria-label="快捷日期区间">
                  {presets.map((preset) => (
                    <button
                      type="button"
                      key={preset.label}
                      onClick={() => selectPreset(preset.days)}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <div className="date-range-actions">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setOpen(false);
                      triggerRef.current?.focus();
                    }}
                  >
                    取消
                  </Button>
                  <Button
                    disabled={!canApply}
                    onClick={() => {
                      onApply(draft);
                      setOpen(false);
                      triggerRef.current?.focus();
                    }}
                  >
                    应用
                  </Button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
