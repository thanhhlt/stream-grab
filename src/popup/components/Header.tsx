import type { Ref } from 'react';
import { EXTENSION_NAME } from '@/shared/constants';
import type { BackgroundState } from '../hooks/useBackgroundStatus';
import { ClawMark } from './ClawMark';

interface HeaderProps {
  status: BackgroundState;
  /** Móng gắp trong header: điểm đến của hiệu ứng gắp. */
  clawRef?: Ref<SVGSVGElement> | undefined;
}

export function Header({ status, clawRef }: HeaderProps) {
  return (
    // z-10: khi gắp, móng hạ xuống đè lên thanh tab.
    <header className="relative z-10 flex h-[50px] shrink-0 items-center gap-2 pr-4 pl-2.5">
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
    </header>
  );
}
