import { Check, ChevronDown, Copy } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import './split-copy-button.css';

export type CopyMode = 'redacted' | 'key';

const modes: { value: CopyMode; label: string }[] = [
  { value: 'redacted', label: '脱敏' },
  { value: 'key', label: '保留 Key' },
];

export function SplitCopyButton({
  format,
  mode,
  loading,
  disabled = false,
  onModeChange,
  onCopy,
}: {
  format: 'CURL' | 'JS 请求';
  mode: CopyMode;
  loading: boolean;
  disabled?: boolean;
  onModeChange: (mode: CopyMode) => void;
  onCopy: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const label = `复制 ${format}（${mode === 'redacted' ? '脱敏' : '保留 Key'}）`;

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    return () => document.removeEventListener('pointerdown', closeOnPointerDown);
  }, [open]);

  return (
    <div
      className="split-copy-button"
      ref={menuRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          toggleRef.current?.focus();
        }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          if (!open) {
            setOpen(true);
            return;
          }
          const items = Array.from(
            menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [],
          );
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? items.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }
      }}
    >
      <button
        type="button"
        className="split-copy-main"
        onClick={() => {
          setOpen(false);
          onCopy();
        }}
        aria-label={label}
        disabled={disabled || loading}
      >
        <Copy size={14} />
        {loading ? '正在生成…' : label}
      </button>
      <button
        ref={toggleRef}
        type="button"
        className="split-copy-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-label={`选择 ${format} 复制方式`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled || loading}
      >
        <ChevronDown size={13} />
      </button>
      {open ? (
        <div
          className="split-copy-dropdown"
          id={menuId}
          role="menu"
          aria-label={`${format} 复制方式`}
        >
          {modes.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={mode === option.value}
              onClick={() => {
                onModeChange(option.value);
                setOpen(false);
                toggleRef.current?.focus();
              }}
            >
              {option.label}
              {mode === option.value ? <Check size={13} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
