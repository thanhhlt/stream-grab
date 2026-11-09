export type ProgressKind = 'download' | 'processing' | 'stalled';

/** Màu phần đã chạy: tải (cam đậm), xử lý FFmpeg (xanh merge), đứng yên (vàng; trang kèm chữ "Stalled"). */
const FILL: Record<ProgressKind, string> = {
  download: 'bg-primary-strong',
  processing: 'bg-merge',
  stalled: 'bg-warning-bar',
};

/** Thanh tiến độ viên thuốc 8 px. Chỉ chuyển động độ rộng (400 ms), không sọc, không ánh chạy. */
export function ProgressBar({
  percent,
  label,
  kind = 'download',
  className = 'bg-track',
}: {
  percent: number;
  label: string;
  kind?: ProgressKind;
  /** Nền rãnh; bảng tổng (nền `surface`) dùng `bg-bg`. */
  className?: string;
}) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      className={`h-2 overflow-hidden rounded-full ${className}`}
    >
      <div className={`h-full rounded-full transition-[width] duration-400 ease-out ${FILL[kind]}`} style={{ width: `${clamped}%` }} />
    </div>
  );
}
