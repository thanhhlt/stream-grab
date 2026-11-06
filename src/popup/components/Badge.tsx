import type { ReactNode } from 'react';
import type { StreamingProtocol } from '@/core/models/detected-stream';
import type { Tone } from '../format';

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  progress: 'bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  accent: 'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
  success: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  warning: 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  danger: 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300',
};

export function Badge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string | undefined }) {
  return (
    <span title={title} className={`inline-flex shrink-0 items-center rounded px-1.5 py-px text-[11px] leading-4 font-medium ${TONE_CLASSES[tone]}`}>
      {children}
    </span>
  );
}

const PROTOCOL_NAMES: Record<StreamingProtocol, string> = { hls: 'HTTP Live Streaming', dash: 'MPEG-DASH' };

/** Nhãn giao thức nhỏ ("HLS", "DASH") đứng đầu dòng thông tin phụ. */
export function ProtocolBadge({ protocol }: { protocol: StreamingProtocol }) {
  return (
    <span
      title={PROTOCOL_NAMES[protocol]}
      className="inline-flex shrink-0 items-center rounded bg-indigo-50 px-1 text-[10px] leading-4 font-semibold tracking-wide text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
    >
      {protocol.toUpperCase()}
    </span>
  );
}
