import type { RequestContext, StreamingProtocol } from '@/core/models/detected-stream';
import type { MediaSegment } from '@/core/models/media-segment';
import type { StreamingManifest } from '@/core/models/streaming-manifest';
import type { VideoVariant } from '@/core/models/video-variant';

export interface ParseOptions {
  /** Referer/Origin of the page's own request, replayed on every derived request. */
  context?: RequestContext;
  signal?: AbortSignal;
  /** Manifest body that was already downloaded (detection), so it is not fetched again. */
  prefetched?: { text: string; finalUrl: string };
}

export interface SegmentOptions {
  /**
   * Alternative audio tracks to include. Defaults to the variant's default
   * track (or its first one). Pass [] for video only.
   */
  audioTrackIds?: readonly string[];
  /** WebVTT subtitle tracks to include (0.7.0); none by default. */
  subtitleTrackIds?: readonly string[];
  signal?: AbortSignal;
}

/**
 * One streaming protocol. Implementations are independent of the download
 * manager and the UI; everything protocol-specific stays behind this interface.
 *
 * Errors are StreamGrabErrors with codes MANIFEST_UNAVAILABLE (cannot fetch),
 * MANIFEST_INVALID (malformed or over limits), DRM_PROTECTED (never yields
 * segments) and UNSUPPORTED.
 */
export interface StreamingProtocolAdapter {
  readonly protocol: StreamingProtocol;
  canHandle(url: string, contentType?: string): boolean;
  parseManifest(url: string, options?: ParseOptions): Promise<StreamingManifest>;
  /** Variants sorted best first (resolution, then bandwidth). */
  getAvailableVariants(manifest: StreamingManifest): Promise<VideoVariant[]>;
  /**
   * All segments needed for `variant` (plus selected audio and subtitle tracks), each with
   * its track and position, so ordering is independent of download order.
   */
  getSegments(manifest: StreamingManifest, variant: VideoVariant, options?: SegmentOptions): Promise<MediaSegment[]>;
}

/** Picks the adapter for a URL, Content-Type or protocol; new protocols only need to register. */
export class ProtocolRegistry {
  readonly #adapters: StreamingProtocolAdapter[] = [];

  register(adapter: StreamingProtocolAdapter): this {
    this.#adapters.push(adapter);
    return this;
  }

  forProtocol(protocol: StreamingProtocol): StreamingProtocolAdapter | undefined {
    return this.#adapters.find((adapter) => adapter.protocol === protocol);
  }

  forUrl(url: string, contentType?: string): StreamingProtocolAdapter | undefined {
    return this.#adapters.find((adapter) => adapter.canHandle(url, contentType));
  }
}

/** Best first: height, then bandwidth; audio-only variants last. */
export function compareVariants(a: VideoVariant, b: VideoVariant): number {
  if (a.audioOnly !== b.audioOnly) return a.audioOnly ? 1 : -1;
  const height = (b.height ?? 0) - (a.height ?? 0);
  if (height !== 0) return height;
  return (b.bandwidth ?? 0) - (a.bandwidth ?? 0);
}
