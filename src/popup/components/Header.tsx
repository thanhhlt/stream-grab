import type { Ref } from 'react';
import { EXTENSION_NAME } from '@/shared/constants';
import type { BackgroundState } from '../hooks/useBackgroundStatus';
import type { ResolvedTheme } from '../theme';
import { BUTTON } from './buttons';
import { ClawMark } from './ClawMark';
import { Icon } from './Icon';

interface HeaderProps {
  status: BackgroundState;
  /** Móng gắp trong header: điểm đến của hiệu ứng gắp. */
  clawRef?: Ref<SVGSVGElement> | undefined;
  /** Theme đang áp dụng; nút ở góc phải chuyển sang theme còn lại. */
  theme: ResolvedTheme;
  onThemeChange: (theme: ResolvedTheme) => void;
}

export function Header({ status, clawRef, theme, onThemeChange }: HeaderProps) {
  // Nút cho biết bấm vào sẽ làm gì: đang sáng thì hiện mặt trăng ("Switch to dark theme").
  const next: ResolvedTheme = theme === 'dark' ? 'light' : 'dark';
  const themeLabel = `Switch to ${next} theme`;
  return (
    // z-10: khi gắp, móng hạ xuống đè lên thanh tab. pr-2.5: biểu tượng trong nút 28 px thẳng lề nội dung 16 px.
    <header className="relative z-10 flex h-[50px] shrink-0 items-center gap-2 pr-2.5 pl-2.5">
      <ClawMark ref={clawRef} />
      <h1 className="text-wordmark text-ink [font-variation-settings:'opsz'_30]">{EXTENSION_NAME}</h1>
      <div className="ml-auto flex items-center gap-1.5 text-meta text-muted">
        {status.state === 'ready' && (
          <>
            <span className="size-[7px] rounded-full bg-success" aria-hidden />
            <span className="tabular-nums">v{status.status.version}</span>
          </>
        )}
        {status.state === 'connecting' && <span>Connecting…</span>}
        {status.state === 'unavailable' && (
          <span className="flex items-center gap-1.5 text-danger" title={status.error}>
            <span className="size-[7px] rounded-full bg-danger" aria-hidden />
            Background unavailable
          </span>
        )}
      </div>
      <button
        type="button"
        aria-label={themeLabel}
        title={themeLabel}
        onClick={() => {
          onThemeChange(next);
        }}
        className={BUTTON.icon}
      >
        <Icon name={next === 'dark' ? 'moon' : 'sun'} />
      </button>
    </header>
  );
}
