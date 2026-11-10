import type { ReactNode } from 'react';
import { SwingingClaw } from './ClawMark';

export type EmptyIcon = 'search' | 'queue' | 'done' | 'off' | 'error';

/** Biểu tượng nét trong vòng tròn `surface`. `search` (Detected đang chờ) là móng gắp đung đưa thay vì biểu tượng. */
const ICON_PATHS: Record<Exclude<EmptyIcon, 'search'>, string> = {
  queue: 'M12 4v10m0 0-4-4m4 4 4-4M5 19h14',
  done: 'M5 12.5 10 17l9-10',
  off: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM5.6 5.6l12.8 12.8',
  error: 'M12 8v5m0 3.5v.01M10.3 3.9 2.5 17.5A2 2 0 0 0 4.2 20.5h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
};

interface EmptyStateProps {
  title: string;
  children: ReactNode;
  icon?: EmptyIcon;
}

export function EmptyState({ title, children, icon }: EmptyStateProps) {
  if (icon === 'search') {
    // Móng treo từ thanh tab xuống; khối móng + chữ nằm giữa vùng trống (dây và khoảng dưới chia đều).
    return (
      <div className="flex h-full flex-col items-center overflow-hidden px-10 text-center">
        <SwingingClaw />
        <p className="mt-3 text-heading text-ink">{title}</p>
        <p className="mt-1 text-ui leading-normal text-muted">{children}</p>
        <span aria-hidden className="min-h-6 flex-1" />
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center px-10 pb-2.5 text-center">
      {icon && (
        <span className="flex size-11 items-center justify-center rounded-full bg-surface text-faint">
          <svg viewBox="0 0 24 24" aria-hidden className="size-5 fill-none stroke-current stroke-[1.8]" strokeLinecap="round" strokeLinejoin="round">
            <path d={ICON_PATHS[icon]} />
          </svg>
        </span>
      )}
      <p className="mt-3 text-heading text-ink">{title}</p>
      <p className="mt-1 text-ui leading-normal text-muted">{children}</p>
    </div>
  );
}
