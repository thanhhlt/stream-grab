/**
 * Kiểu nút dùng chung của popup (Claw, docs/DESIGN.md): nút viên thuốc cao 30 px, một hành động
 * chính mỗi màn hình, hành động trên từng dòng là nút viền. Chiều cao nằm trong từng biến thể
 * (không nằm ở `base`) để nút biểu tượng 28 px không xung đột.
 */
const base =
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-full border-[1.5px] border-transparent text-ui font-semibold whitespace-nowrap transition-[color,background-color,border-color,filter] duration-120 ease-out disabled:cursor-not-allowed disabled:opacity-40';

export const BUTTON = {
  /** Hành động chính của màn hình (Download selected, Retry). */
  primary: `${base} h-[30px] bg-primary px-[13px] text-on-primary hover:brightness-95 active:brightness-90 disabled:hover:brightness-100`,
  /** Tải về trên từng dòng (Download của một luồng, Show in folder): viền cam, chữ cam, kèm mũi tên tải. */
  download: `${base} h-[30px] border-primary-strong pr-[11px] pl-[9px] text-primary-text hover:bg-selected active:bg-selected disabled:hover:bg-transparent`,
  /** Xác nhận một hành động khó hoàn tác (Remove all trong hộp thoại xác nhận). */
  danger: `${base} h-[30px] bg-danger px-[13px] text-on-danger hover:brightness-95 active:brightness-90`,
  /** Hành động phụ có viền (Cancel, Remove). */
  secondary: `${base} h-[30px] border-line bg-bg px-[13px] text-ink hover:bg-surface active:bg-surface disabled:hover:bg-bg`,
  /** Hành động nhẹ dạng chữ (Clear list, Clear all). */
  ghost: `${base} h-[30px] px-2.5 text-muted hover:bg-surface hover:text-ink`,
  /** Liên kết nhấn mạnh trong thanh tiêu đề mục (Retry all failed). */
  link: `${base} h-[30px] px-2.5 text-primary-text hover:bg-selected`,
  /** Nút biểu tượng tròn (×, ⋯): vùng bấm 28 px. */
  icon: `${base} size-7 text-faint hover:bg-surface hover:text-ink`,
} as const;
