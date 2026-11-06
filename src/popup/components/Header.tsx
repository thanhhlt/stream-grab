import { EXTENSION_NAME } from '@/shared/constants';
import type { BackgroundState } from '../hooks/useBackgroundStatus';

const ICON_URL = '/icons/icon-32.png';

export function Header({ status }: { status: BackgroundState }) {
  return (
    <header className="flex items-center gap-2.5 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
      <img src={ICON_URL} alt="" width={22} height={22} />
      <h1 className="text-base font-semibold tracking-tight">{EXTENSION_NAME}</h1>
      <div className="ml-auto flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
        {status.state === 'ready' && (
          <>
            <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
            <span>v{status.status.version}</span>
          </>
        )}
        {status.state === 'connecting' && <span>Connecting…</span>}
        {status.state === 'unavailable' && (
          <span className="flex items-center gap-1.5 text-red-600 dark:text-red-400" title={status.error}>
            <span className="size-1.5 rounded-full bg-red-500" aria-hidden />
            Background unavailable
          </span>
        )}
      </div>
    </header>
  );
}
