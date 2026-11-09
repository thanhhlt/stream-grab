/**
 * Bộ biểu tượng nét 16 px của popup (Claw). Một nét 1.9, đầu tròn; riêng `play` tô đặc.
 * Luôn là trang trí (`aria-hidden`): nút chỉ có biểu tượng phải tự mang `aria-label`.
 */
export type IconName = 'chevron' | 'close' | 'tick' | 'download' | 'lock' | 'clock' | 'play' | 'warning';

const PATHS: Record<Exclude<IconName, 'lock' | 'clock'>, string> = {
  chevron: 'M4.5 6.5 8 10l3.5-3.5',
  close: 'M4.5 4.5l7 7m0-7l-7 7',
  tick: 'M3.5 8.5l3 3 6-7',
  download: 'M8 2.5v8m-3.5-3.5L8 10.5 11.5 7M3 13.5h10',
  play: 'M5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5Z',
  warning: 'M8 5.5v3.5m0 2.3v.1M7 2.6 1.6 12.2A1.2 1.2 0 0 0 2.6 14h10.8a1.2 1.2 0 0 0 1-1.8L9 2.6a1.2 1.2 0 0 0-2 0Z',
};

export function Icon({ name, className = 'size-4' }: { name: IconName; className?: string }) {
  const filled = name === 'play';
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className={`shrink-0 ${className}`}
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {name === 'lock' ? (
        <>
          <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
          <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
        </>
      ) : name === 'clock' ? (
        <>
          <circle cx="8" cy="8" r="5.8" />
          <path d="M8 5v3.2l2 1.3" />
        </>
      ) : (
        <path d={PATHS[name]} />
      )}
    </svg>
  );
}
