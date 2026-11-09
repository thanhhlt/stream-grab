/** Kiểu nút dùng chung của popup: một hành động chính, các hành động phụ nhẹ hơn. */
const base =
  'inline-flex shrink-0 items-center justify-center gap-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-40';

export const BUTTON = {
  /** Hành động chính (Download, Show in folder, Retry). */
  primary: `${base} bg-indigo-600 px-2.5 py-1 font-semibold text-white hover:bg-indigo-500 active:bg-indigo-700 disabled:hover:bg-indigo-600`,
  /** Xác nhận một hành động khó hoàn tác (Remove all trong hộp thoại xác nhận). */
  danger: `${base} bg-red-600 px-2.5 py-1 font-semibold text-white hover:bg-red-500 active:bg-red-700`,
  /** Hành động phụ có viền (Cancel, Remove). */
  secondary: `${base} border border-slate-300 px-2 py-[3px] text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800`,
  /** Hành động nhẹ dạng chữ (Clear list, Clear all). */
  ghost: `${base} px-2 py-1 text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100`,
  /** Liên kết nhấn mạnh trong thanh tiêu đề mục (Retry all failed). */
  link: `${base} px-2 py-0.5 text-indigo-700 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-500/10`,
  /** Nút biểu tượng vuông nhỏ (×, ⋯). */
  icon: `${base} size-6 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200`,
} as const;
