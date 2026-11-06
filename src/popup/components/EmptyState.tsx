import type { ReactNode } from 'react';

export type EmptyIcon = 'search' | 'queue' | 'done' | 'off' | 'error';

/** Biểu tượng nét mảnh, màu nhạt — chỉ để nhận diện nhanh trạng thái trống. */
const ICON_PATHS: Record<EmptyIcon, string> = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-4-4',
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
  return (
    <div className="flex h-full flex-col items-center justify-center px-10 text-center">
      {icon && (
        <span className="mb-3 flex size-10 items-center justify-center rounded-full bg-slate-100 text-slate-400 dark:bg-slate-800/70 dark:text-slate-500">
          <svg viewBox="0 0 24 24" aria-hidden className="size-5 fill-none stroke-current stroke-[1.8]" strokeLinecap="round" strokeLinejoin="round">
            <path d={ICON_PATHS[icon]} />
          </svg>
        </span>
      )}
      <p className="font-medium text-slate-700 dark:text-slate-200">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{children}</p>
    </div>
  );
}
