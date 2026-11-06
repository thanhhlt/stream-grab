/** Thanh tiến độ: `download` (mạng, indigo) và `processing` (FFmpeg, violet) có màu khác nhau để phân biệt. */
export function ProgressBar({ percent, label, kind = 'download' }: { percent: number; label: string; kind?: 'download' | 'processing' }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      className="h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
    >
      <div
        className={`h-full rounded-full transition-[width] duration-300 ${
          kind === 'processing' ? 'bg-violet-500 dark:bg-violet-400' : 'bg-indigo-600 dark:bg-indigo-400'
        }`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
