import type { KeyboardEvent, Ref } from 'react';

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
  /** Thanh tab: hiệu ứng gắp tìm điểm hạ cánh trong đó (`data-tab`, `data-tab-count`). */
  ref?: Ref<HTMLDivElement> | undefined;
}

export function TabBar({ active, onChange, counts = {}, ref }: TabBarProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = TABS.findIndex((tab) => tab.id === active);
    const offset = event.key === 'ArrowRight' ? 1 : TABS.length - 1;
    const next = TABS[(index + offset) % TABS.length];
    if (next) onChange(next.id);
  };

  return (
    <div ref={ref} role="tablist" aria-label="Sections" className="flex shrink-0 gap-0.5 border-b border-line px-2 pb-2" onKeyDown={onKeyDown}>
      {TABS.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            data-tab={tab.id}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              onChange(tab.id);
            }}
            className={`inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-full px-3 text-ui font-semibold transition-colors duration-120 ease-out ${
              selected ? 'bg-surface text-ink' : 'text-muted hover:text-ink'
            }`}
          >
            {tab.label}
            {(counts[tab.id] ?? 0) > 0 && (
              // Vòng tròn cam 19 px; là điểm hạ cánh của hiệu ứng gắp (tìm qua data-tab-count).
              <span
                data-tab-count={tab.id}
                className="inline-grid h-[19px] min-w-[19px] place-items-center rounded-full bg-primary px-[5px] text-badge text-on-primary tabular-nums"
              >
                {counts[tab.id]}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
