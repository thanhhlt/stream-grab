import type { KeyboardEvent } from 'react';

export const TABS = [
  { id: 'detected', label: 'Detected' },
  { id: 'queue', label: 'Queue' },
  { id: 'completed', label: 'Completed' },
  { id: 'settings', label: 'Settings' },
] as const;

export type TabId = (typeof TABS)[number]['id'];

interface TabBarProps {
  active: TabId;
  onChange: (tab: TabId) => void;
  /** Small count shown next to a tab label (e.g. active downloads). */
  counts?: Partial<Record<TabId, number>>;
}

export function TabBar({ active, onChange, counts = {} }: TabBarProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = TABS.findIndex((tab) => tab.id === active);
    const offset = event.key === 'ArrowRight' ? 1 : TABS.length - 1;
    const next = TABS[(index + offset) % TABS.length];
    if (next) onChange(next.id);
  };

  return (
    <div
      role="tablist"
      aria-label="Sections"
      className="flex gap-1 border-b border-slate-200 px-2 dark:border-slate-800"
      onKeyDown={onKeyDown}
    >
      {TABS.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              onChange(tab.id);
            }}
            className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-indigo-500 ${
              selected
                ? 'border-indigo-600 text-indigo-700 dark:border-indigo-400 dark:text-indigo-300'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            {tab.label}
            {(counts[tab.id] ?? 0) > 0 && (
              <span className="ml-1.5 rounded-full bg-indigo-100 px-1.5 py-px text-[10px] font-semibold text-indigo-700 dark:bg-indigo-900 dark:text-indigo-200">
                {counts[tab.id]}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
