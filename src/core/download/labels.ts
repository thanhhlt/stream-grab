/** Human-readable quality labels, shared by the popup and task creation. */

export interface QualityLike {
  height?: number | undefined;
  frameRate?: number | undefined;
  bandwidth?: number | undefined;
  audioOnly: boolean;
}

/** 5_000_000 → "5.0 Mbps", 800_000 → "800 kbps". */
export function formatBitrate(bitsPerSecond: number): string {
  if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`;
  return `${Math.round(bitsPerSecond / 1000)} kbps`;
}

/** "1080p", "720p60", "Audio only", or the bitrate when no resolution is declared. */
export function variantLabel(variant: QualityLike): string {
  if (variant.audioOnly) return 'Audio only';
  if (variant.height !== undefined) {
    const highFrameRate = variant.frameRate !== undefined && variant.frameRate > 31 ? String(Math.round(variant.frameRate)) : '';
    return `${variant.height}p${highFrameRate}`;
  }
  if (variant.bandwidth !== undefined) return formatBitrate(variant.bandwidth);
  return 'Single quality';
}
