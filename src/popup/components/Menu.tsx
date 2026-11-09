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
        className={`${BUTTON.icon} ${open ? 'bg-surface text-ink' : ''}`}
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
          className={`absolute right-0 z-10 min-w-40 ${upward ? 'bottom-full mb-1' : 'top-full mt-1'} rounded-tile border border-line bg-bg p-1 shadow-pop`}
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
              // Viền focus thụt vào trong để không bị mép menu che.
              className={`flex h-[30px] w-full cursor-pointer items-center rounded-lg px-2.5 text-left text-ui whitespace-nowrap transition-colors duration-120 hover:bg-surface focus-visible:bg-surface focus-visible:-outline-offset-2 ${
                item.danger ? 'text-danger' : 'text-ink'
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
