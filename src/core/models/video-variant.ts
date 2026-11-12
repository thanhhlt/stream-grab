import type { StreamingProtocol } from './detected-stream';

/** One selectable quality of a stream (HLS variant stream, DASH video representation). */
export interface VideoVariant {
  /** Stable within the manifest it came from. */
  id: string;
  protocol: StreamingProtocol;
  /** Peak bits per second, as declared. */
  bandwidth?: number;
  averageBandwidth?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  /** Raw RFC 6381 codec strings, e.g. ["avc1.640028", "mp4a.40.2"]. */
  codecs: string[];
  videoCodec?: string;
  audioCodec?: string;
  /** True when the variant carries no video (audio-only rendition). */
  audioOnly: boolean;
  /** Alternative audio tracks that may be combined with this variant; empty when audio is muxed or absent. */
  audioTrackIds: string[];
  /** Subtitle tracks that may be saved with this variant (0.7.0). */
  subtitleTrackIds?: string[];
  hls?: {
    playlistUrl: string;
    audioGroupId?: string;
    subtitleGroupId?: string;
  };
  dash?: {
    /** Representation@id (unique within a Period; periods are joined by it). */
    representationId: string;
  };
}
