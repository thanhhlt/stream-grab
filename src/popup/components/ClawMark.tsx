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

/**
 * Móng gắp lớn của trạng thái trống ở Detected, treo như trong máy gắp thú: con trượt bám dưới đường kẻ
 * của thanh tab (thanh ray), sợi dây lấp khoảng phía trên (`flex-1`, co giãn theo chiều cao popup).
 * Cả dây và móng đung đưa ±2° quanh con trượt, chậm như con lắc dài; đứng yên khi giảm chuyển động.
 */
export function SwingingClaw() {
  return (
    <div aria-hidden className="flex min-h-[72px] flex-1 flex-col items-center">
      <span className="h-[5px] w-4 shrink-0 rounded-b-[3px] bg-ink" />
      <div className="flex flex-1 origin-top flex-col items-center motion-safe:animate-claw-swing">
        <span className="w-0.5 flex-1 bg-ink" />
        <svg viewBox="0 44 64 36" className="h-[45px] w-20 shrink-0 overflow-visible">
          <rect x="22" y="44" width="20" height="13" rx="5" className="fill-ink" />
          <path d="M27 56c-9 5-11 14-6 21l5-2.5" className="fill-none stroke-primary" strokeWidth="4.5" strokeLinecap="round" />
          <path d="M37 56c9 5 11 14 6 21l-5-2.5" className="fill-none stroke-primary" strokeWidth="4.5" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
}
