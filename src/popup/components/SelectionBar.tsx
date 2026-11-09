import { useEffect, useRef } from 'react';
import type { SelectAllState } from '../selection';
import { BUTTON } from './buttons';
import { Icon } from './Icon';

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

/** Nút chữ "Clear list" với lề 6 px như bản mẫu, để thanh còn chỗ cho số đã chọn. */
const CLEAR_LIST = BUTTON.ghost.replace('px-2.5', 'px-1.5');
/**
 * Nút chính co trước nhãn (hệ số co rất lớn; tổng hệ số < 1 thì flexbox chỉ chia một phần chỗ thiếu).
 * Độ rộng tối thiểu tự động của nó là độ rộng của chữ: biểu tượng rơi đi trước, rồi mới đến lượt nhãn.
 */
const DOWNLOAD_SELECTED = BUTTON.primary.replace('shrink-0', 'shrink-[1000]');

/** "Select all" (tri-state), counts, "Clear list" and the batch Download button. */
export function SelectionBar({ total, selectable, selected, state, onSelectAll, onDownload, onClear, busy }: SelectionBarProps) {
  const checkbox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (checkbox.current) checkbox.current.indeterminate = state === 'some';
  }, [state]);

  return (
    // Số đã chọn không bao giờ bị cắt. Khi hết chỗ, nút Download selected co lại trước (bỏ biểu tượng),
    // rồi nhãn mới xuống dòng giữa hai cụm chữ. Chiều cao cố định để danh sách không nhảy khi chọn.
    <div className="flex h-[52px] shrink-0 items-center gap-2 pr-3 pl-4">
      <label className="flex min-w-0 cursor-pointer items-center gap-2.5 leading-tight text-muted">
        <input
          ref={checkbox}
          type="checkbox"
          checked={state === 'all'}
          disabled={selectable === 0}
          onChange={() => {
            onSelectAll(state !== 'all');
          }}
          aria-label="Select all downloadable videos"
          className="size-[18px] shrink-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
        />
        {/* Hai cụm không tách rời; nếu buộc phải xuống dòng thì chỉ xuống giữa hai cụm. */}
        <span className="tabular-nums">
          {selected > 0 ? (
            <>
              <span className="whitespace-nowrap">
                <span className="font-bold text-ink">{selected}</span> of {selectable}
              </span>{' '}
              <span className="whitespace-nowrap">selected</span>
            </>
          ) : (
            <>
              <span className="whitespace-nowrap">
                {total} {total === 1 ? 'stream' : 'streams'}
              </span>{' '}
              <span className="whitespace-nowrap">on this page</span>
            </>
          )}
        </span>
      </label>
      <button type="button" onClick={onClear} className={`${CLEAR_LIST} ml-auto`}>
        Clear list
      </button>
      <button type="button" disabled={selected === 0 || busy} onClick={onDownload} className={DOWNLOAD_SELECTED}>
        {/*
          Hàng đảo + xuống dòng: chữ luôn ở dòng đầu; khi nút bị ép hẹp hơn chữ + biểu tượng, biểu tượng
          rơi xuống dòng thứ hai, bị cắt bởi overflow (chỉ CSS, không đo bằng JS).
        */}
        <span className="flex h-full flex-row-reverse flex-wrap content-start items-center justify-center gap-x-1.5 overflow-hidden">
          <span className="leading-[27px]">{busy ? 'Queuing…' : selected > 0 ? `Download selected (${selected})` : 'Download selected'}</span>
          <span className="grid h-[27px] place-items-center">
            <Icon name="download" />
          </span>
        </span>
      </button>
    </div>
  );
}
