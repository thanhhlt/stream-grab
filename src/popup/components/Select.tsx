import type { ComponentProps } from 'react';
import { Icon } from './Icon';

interface SelectProps extends Omit<ComponentProps<'select'>, 'className'> {
  /** Độ rộng của viên thuốc (vd. `max-w-36`, `w-44`). */
  className?: string;
}

/**
 * Ô chọn dạng viên thuốc (Claw): nền `surface`, cao 30 px, mũi tên riêng thay cho mũi tên của
 * trình duyệt. Vẫn là `<select>` gốc nên bàn phím, nhãn và danh sách lựa chọn giữ nguyên.
 */
export function Select({ className = '', children, ...props }: SelectProps) {
  return (
    <span className={`relative inline-flex shrink-0 ${className}`}>
      <select
        {...props}
        className="h-[30px] w-full min-w-0 cursor-pointer appearance-none truncate rounded-full bg-surface pr-7 pl-[11px] text-control text-ink transition-colors duration-120 ease-out hover:bg-line"
      >
        {children}
      </select>
      <Icon name="chevron" className="pointer-events-none absolute top-1/2 right-2.5 size-[13px] -translate-y-1/2 text-muted" />
    </span>
  );
}
