import type { ReactNode } from 'react';
import type { MediaProtocol, ProgressiveContainer } from '@/core/models/detected-stream';
import type { Tone } from '../format';

/** Ánh xạ `Tone` sang token Claw (docs/DESIGN.md, "Color tokens"). */
const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-surface text-muted',
  progress: 'bg-selected text-primary-text',
  accent: 'bg-merge-surface text-merge-text',
  success: 'bg-success-surface text-success',
  warning: 'bg-warning-surface text-warning',
  danger: 'bg-danger-surface text-danger',
};

/** Chip trạng thái: viên thuốc cao 20 px. Màu không bao giờ là tín hiệu duy nhất: chip luôn có chữ. */
export function Badge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string | undefined }) {
  return (
    <span
      title={title}
      className={`inline-flex h-5 shrink-0 items-center rounded-full px-2 align-middle text-tech font-semibold whitespace-nowrap ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}

const PROTOCOL_NAMES: Record<MediaProtocol, string> = { hls: 'HTTP Live Streaming', dash: 'MPEG-DASH', progressive: 'Video file' };
const CONTAINER_LABELS: Record<ProgressiveContainer, string> = { mp4: 'MP4', webm: 'WebM' };

/**
 * Tên giao thức ("HLS", "DASH"; file progressive: "MP4", "WebM"). Không còn là nhãn màu: chỉ là chữ
 * trong dòng kỹ thuật hoặc bảng Options, kế thừa cỡ và màu của dòng đó, giữ tooltip tên đầy đủ.
 */
export function ProtocolBadge({ protocol, container }: { protocol: MediaProtocol; container?: ProgressiveContainer | undefined }) {
  const label = protocol === 'progressive' ? (container ? CONTAINER_LABELS[container] : 'File') : protocol.toUpperCase();
  const title = protocol === 'progressive' && container ? `${PROTOCOL_NAMES[protocol]} (${CONTAINER_LABELS[container]})` : PROTOCOL_NAMES[protocol];
  return (
    <span title={title} className="shrink-0">
      {label}
    </span>
  );
}
