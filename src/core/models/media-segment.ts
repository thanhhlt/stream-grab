/** Byte range within a resource (EXT-X-BYTERANGE, SegmentBase/indexRange). `offset` is the first byte. */
export interface ByteRange {
  offset: number;
  length: number;
}

/**
 * Container of a segment, as declared by the manifest. Merging (Phase 9) uses
 * it to pick the demux workflow and verifies it against the bytes.
 */
export type ContainerFormat = 'mpeg-ts' | 'fmp4' | 'webm' | 'packed-audio' | 'unknown';

/**
 * Encryption that the extension can undo with keys the page itself fetches.
 * DRM-protected content never yields segments, so it has no variant here.
 * `iv` is 32 lower-case hex characters (128 bits).
 */
export type SegmentEncryption =
  | { method: 'AES-128'; keyUrl: string; iv: string }
  | { method: 'SAMPLE-AES'; keyUrl: string; iv: string };

/** `main`: the variant's own playlist (video, possibly with muxed audio). `audio`: an alternative audio rendition. */
export const TRACK_TYPES = ['main', 'audio'] as const;
export type TrackType = (typeof TRACK_TYPES)[number];

export interface MediaSegment {
  /** Unique within one download: `${trackId}:${index}`. */
  id: string;
  trackId: string;
  trackType: TrackType;
  /** 0-based position within its track, init segments included. Output order, regardless of download order. */
  index: number;
  kind: 'init' | 'media';
  url: string;
  byteRange?: ByteRange;
  /** Seconds; 0 for init segments. */
  duration: number;
  /** HLS media sequence number of media segments. */
  mediaSequence?: number;
  /** Discontinuity sequence: timestamps, codecs or encoding may change where it increments. */
  discontinuity: number;
  encryption?: SegmentEncryption;
  /** For fMP4 media segments: the init segment they need. */
  initSegmentId?: string;
  container: ContainerFormat;
}
