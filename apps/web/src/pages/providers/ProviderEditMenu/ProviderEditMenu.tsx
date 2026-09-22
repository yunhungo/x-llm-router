/**
 * @created 2026-09-22
 * @description 提供上游卡片编辑菜单的连接与模型价格入口。
 * @author yunhungo
 */
import { useEffect, useRef, useState } from 'react';
import { Pencil, Settings2, Coins } from 'lucide-react';
import './ProviderEditMenu.scss';
export function ProviderEditMenu({
  name,
  onEdit,
  onPrices,
}: {
  name: string;
  onEdit: () => void;
  onPrices: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return (
    <div
      className='provider-edit-menu'
      ref={root}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        className='icon-button'
        type='button'
        aria-label={`编辑 ${name}`}
        aria-expanded={open}
        title='编辑上游'
        onClick={() => setOpen(!open)}
      >
        <Pencil size={15} />
      </button>
      {open ? (
        <div className='provider-edit-menu__popup' aria-label='编辑上游菜单'>
          <button
            type='button'
            onClick={() => {
              setOpen(false);
              onEdit();
            }}
          >
            <Settings2 size={15} />
            连接设置
          </button>
          <button
            type='button'
            onClick={() => {
              setOpen(false);
              onPrices();
            }}
          >
            <Coins size={15} />
            模型价格
          </button>
        </div>
      ) : null}
    </div>
  );
}
