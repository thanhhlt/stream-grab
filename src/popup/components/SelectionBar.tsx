import { useEffect, useRef } from 'react';
import type { SelectAllState } from '../selection';
import { BUTTON } from './buttons';

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
    <div className="flex items-center gap-2 border-b border-slate-200 py-2 pr-3 pl-4 dark:border-slate-800">
      <label className="flex min-w-0 cursor-pointer items-center gap-2.5 text-xs text-slate-600 dark:text-slate-300">
        <input
          ref={checkbox}
          type="checkbox"
          checked={state === 'all'}
          disabled={selectable === 0}
          onChange={() => {
            onSelectAll(state !== 'all');
          }}
          aria-label="Select all downloadable videos"
          className="size-4 cursor-pointer accent-indigo-600 disabled:cursor-not-allowed disabled:opacity-40 dark:accent-indigo-400"
        />
        <span className="truncate tabular-nums">
          {selected > 0 ? (
            <>
              <span className="font-semibold text-slate-800 dark:text-slate-100">{selected}</span> of {selectable} selected
            </>
          ) : (
            `${total} ${total === 1 ? 'stream' : 'streams'} on this page`
          )}
        </span>
      </label>
      <button type="button" onClick={onClear} className={`${BUTTON.ghost} ml-auto`}>
        Clear list
      </button>
      <button type="button" disabled={selected === 0 || busy} onClick={onDownload} className={BUTTON.primary}>
        {busy ? 'Queuing…' : selected > 0 ? `Download selected (${selected})` : 'Download selected'}
      </button>
    </div>
  );
}
