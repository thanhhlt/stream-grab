import type { Ref } from 'react';

/**
 * Dấu móng gắp của Claw: sợi dây và nắp màu `ink`, hai càng cam có móc quặp vào trong
 * (docs/DESIGN.md, "Identity"). Toàn bộ là trang trí (`aria-hidden`).
 */

/**
 * Móng gắp 30 × 50 treo từ mép trên của header. Hiệu ứng gắp (bước 2) tìm các phần qua
 * `data-claw-part`: `rig` (cả cụm, hạ 9 px) và `prong-left`/`prong-right` (càng mở 20° → khép 0°,
 * qua thuộc tính `rotate`, quanh gốc càng).
 */
export function ClawMark({ ref }: { ref?: Ref<SVGSVGElement> | undefined }) {
  return (
    <svg ref={ref} viewBox="0 0 32 50" aria-hidden className="h-[50px] w-[30px] shrink-0 self-start overflow-visible">
      <g data-claw-part="rig">
        {/* Dây kéo dài lên quá mép trên của popup. */}
        <line x1="16" y1="-60" x2="16" y2="25" className="stroke-ink" strokeWidth="1.6" />
        <rect x="10" y="24" width="12" height="8" rx="3" className="fill-ink" />
        <path
          data-claw-part="prong-left"
          d="M13 31c-5 3-6.5 8-3.5 12l3.2-1.6"
          className="origin-[13px_31px] rotate-20 fill-none stroke-primary"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <path
          data-claw-part="prong-right"
          d="M19 31c5 3 6.5 8 3.5 12l-3.2-1.6"
          className="origin-[19px_31px] -rotate-20 fill-none stroke-primary"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}

/** Móng gắp lớn của trạng thái trống ở Detected: đung đưa ±5° quanh đầu dây; đứng yên khi giảm chuyển động. */
export function SwingingClaw() {
  return (
    <svg viewBox="0 0 64 92" aria-hidden className="h-[92px] w-16 shrink-0 overflow-visible">
      <g className="origin-[32px_0] motion-safe:animate-claw-swing">
        <line x1="32" y1="0" x2="32" y2="46" className="stroke-ink" strokeWidth="2" />
        <rect x="22" y="44" width="20" height="13" rx="5" className="fill-ink" />
        <path d="M27 56c-9 5-11 14-6 21l5-2.5" className="fill-none stroke-primary" strokeWidth="4.5" strokeLinecap="round" />
        <path d="M37 56c9 5 11 14 6 21l-5-2.5" className="fill-none stroke-primary" strokeWidth="4.5" strokeLinecap="round" />
      </g>
    </svg>
  );
}
