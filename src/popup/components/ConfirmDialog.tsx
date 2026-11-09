import { useEffect, useId, useRef, type ReactNode } from 'react';
import { BUTTON } from './buttons';

interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Hộp thoại xác nhận trong popup (vd. Remove all). Focus vào Cancel khi mở,
 * Tab chỉ đi giữa các nút của hộp thoại, Escape hoặc bấm ra ngoài là Cancel.
 */
export function ConfirmDialog({ title, children, confirmLabel, onConfirm, onCancel }: ConfirmDialogProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    cancel.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-scrim p-6"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="w-full max-w-[300px] rounded-dialog bg-bg p-5 shadow-pop ring-1 ring-line"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onCancel();
            return;
          }
          if (event.key !== 'Tab') return;
          const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
          const first = buttons[0];
          const last = buttons.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <h2 id={titleId} className="text-heading text-ink">
          {title}
        </h2>
        <p id={bodyId} className="mt-1.5 text-ui text-muted">
          {children}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button ref={cancel} type="button" onClick={onCancel} className={BUTTON.secondary}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} className={BUTTON.danger}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
