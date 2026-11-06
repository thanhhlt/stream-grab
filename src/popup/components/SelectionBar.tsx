import { useEffect, useRef } from 'react';
import type { SelectAllState } from '../selection';

interface SelectionBarProps {
  total: number;
  selectable: number;
  selected: number;
  state: SelectAllState;
  onSelectAll: (select: boolean) => void;
  onDownload: () => void;
  onClear: () => void;
  busy: boolean;
}

/** "Select all" (tri-state), counts, "Clear list" and the batch Download button. */
export function SelectionBar({ total, selectable, selected, state, onSelectAll, onDownload, onClear, busy }: SelectionBarProps) {
  const checkbox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (checkbox.current) checkbox.current.indeterminate = state === 'some';
  }, [state]);

  return (
    <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-2 dark:border-slate-800">
      <label className="flex min-w-0 items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
        <input
          ref={checkbox}
          type="checkbox"
          checked={state === 'all'}
          disabled={selectable === 0}
          onChange={() => {
            onSelectAll(state !== 'all');
          }}
          aria-label="Select all downloadable videos"
          className="size-4 accent-indigo-600 disabled:opacity-40"
        />
        <span className="truncate">
          {selected > 0 ? `${selected} of ${selectable} selected` : `${total} ${total === 1 ? 'stream' : 'streams'} on this page`}
        </span>
      </label>
      <button
        type="button"
        onClick={onClear}
        className="ml-auto shrink-0 text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline dark:text-slate-400 dark:hover:text-slate-200"
      >
        Clear list
      </button>
      <button
        type="button"
        disabled={selected === 0 || busy}
        onClick={onDownload}
        className="shrink-0 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? 'Queuing…' : `Download${selected > 0 ? ` (${selected})` : ''}`}
      </button>
    </div>
  );
}
