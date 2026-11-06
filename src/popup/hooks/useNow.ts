import { useEffect, useState } from 'react';

/**
 * Giờ hiện tại, cập nhật mỗi `intervalMs` khi `active` (vd. khi có task đang
 * tải): để popup nhận ra lượt tải đứng yên dù không có báo cáo mới.
 */
export function useNow(intervalMs: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [intervalMs, active]);
  return now;
}
