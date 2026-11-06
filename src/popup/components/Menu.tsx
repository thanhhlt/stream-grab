import { useEffect, useId, useRef, useState } from 'react';
import { BUTTON } from './buttons';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** Mô tả ngắn hiện khi rê chuột. */
  title?: string;
  danger?: boolean;
}

/**
 * Menu "⋯" cho hành động phụ (vd. Remove). Đóng khi chọn, khi nhấn Escape,
 * khi bấm ra ngoài hoặc khi focus rời menu.
 */
export function Menu({ label, items }: { label: string; items: readonly MenuItem[] }) {
  const [open, setOpen] = useState(false);
  /** Mở lên trên khi nút nằm sát đáy popup (danh sách cuộn sẽ cắt menu). */
  const [upward, setUpward] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    // Focus vào mục đầu tiên để dùng được bằng bàn phím.
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  return (
    <div
      ref={root}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          close(true);
        }
      }}
      onBlur={(event) => {
        if (open && !root.current?.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(event) => {
          setUpward(event.currentTarget.getBoundingClientRect().bottom > window.innerHeight - 96);
          setOpen((value) => !value);
        }}
        className={`${BUTTON.icon} ${open ? 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200' : ''}`}
      >
        <svg viewBox="0 0 16 16" aria-hidden className="size-4 fill-current">
          <circle cx="3" cy="8" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="13" cy="8" r="1.4" />
        </svg>
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className={`absolute right-0 z-10 min-w-36 ${upward ? 'bottom-full mb-1' : 'top-full mt-1'} overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900`}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              title={item.title}
              onClick={() => {
                close(false);
                item.onSelect();
              }}
              className={`block w-full px-3 py-1.5 text-left text-xs hover:bg-slate-100 focus-visible:bg-slate-100 focus-visible:outline-none dark:hover:bg-slate-800 dark:focus-visible:bg-slate-800 ${
                item.danger ? 'text-red-700 dark:text-red-300' : 'text-slate-700 dark:text-slate-200'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
