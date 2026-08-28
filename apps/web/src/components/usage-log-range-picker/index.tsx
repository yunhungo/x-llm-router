import { CalendarDays, ChevronDown } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  datetimeLocalIso,
  datetimeLocalValue,
  usageLogTimeRangeError,
  type UsageLogFiltersState,
} from '../../features/usage/usage-log-pagination';
import { Button } from '../ui';
import './usage-log-range-picker.css';

type UsageLogRange = Pick<UsageLogFiltersState, 'from' | 'to'>;

const rangeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function formatRangeValue(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? rangeFormatter.format(date) : '未选择';
}

export function UsageLogRangePicker({
  value,
  onApply,
}: {
  value: UsageLogRange;
  onApply: (range: UsageLogRange) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const fromInputRef = useRef<HTMLInputElement>(null);
  const rangeError = usageLogTimeRangeError(draft);

  const updatePosition = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const panelWidth = Math.min(420, window.innerWidth - 24);
    const panelHeight = panelRef.current?.offsetHeight ?? 290;
    const left = Math.min(
      Math.max(12, rect.right - panelWidth),
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
    setDraft(value);
    setOpen(true);
    requestAnimationFrame(() => fromInputRef.current?.focus());
  };

  const selectPreset = (days: number) => {
    const to = new Date();
    setDraft({
      from: new Date(to.getTime() - days * 86_400_000).toISOString(),
      to: to.toISOString(),
    });
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="usage-range-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPicker())}
      >
        <CalendarDays size={14} />
        <span>
          {formatRangeValue(value.from)} <i>—</i> {formatRangeValue(value.to)}
        </span>
        <ChevronDown size={13} />
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              className="usage-range-popover"
              role="dialog"
              aria-label="选择调用记录时间区间"
              style={position}
            >
              <strong>时间区间</strong>
              <div className="usage-range-fields">
                <label>
                  <span>开始时间</span>
                  <input
                    ref={fromInputRef}
                    type="datetime-local"
                    step="60"
                    value={datetimeLocalValue(draft.from)}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        from: datetimeLocalIso(event.target.value),
                      }))
                    }
                  />
                </label>
                <label>
                  <span>结束时间</span>
                  <input
                    type="datetime-local"
                    step="60"
                    value={datetimeLocalValue(draft.to)}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        to: datetimeLocalIso(event.target.value),
                      }))
                    }
                  />
                </label>
              </div>
              <div className="usage-range-presets" aria-label="快捷时间区间">
                <button type="button" onClick={() => selectPreset(1)}>
                  过去 24 小时
                </button>
                <button type="button" onClick={() => selectPreset(7)}>
                  过去 7 天
                </button>
                <button type="button" onClick={() => selectPreset(30)}>
                  过去 30 天
                </button>
              </div>
              {rangeError ? (
                <div className="usage-range-error" role="alert">
                  {rangeError}
                </div>
              ) : null}
              <div className="usage-range-actions">
                <Button variant="secondary" onClick={() => setOpen(false)}>
                  取消
                </Button>
                <Button
                  disabled={Boolean(rangeError)}
                  onClick={() => {
                    onApply(draft);
                    setOpen(false);
                  }}
                >
                  应用
                </Button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
