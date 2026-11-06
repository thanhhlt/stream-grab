import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  children: ReactNode;
}

export function EmptyState({ title, children }: EmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <p className="font-medium text-slate-700 dark:text-slate-200">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{children}</p>
    </div>
  );
}
