import type { ContainerFormat, TrackType } from './media-segment';

/**
 * How the stored segments of one track fit together, without any URL (signed
 * links stay out of IndexedDB). Saved with the task's plan when segments are
 * downloaded; media processing reads it to assemble each track in order.
 */
export interface TrackLayout {
  trackId: string;
  trackType: TrackType;
  /** Stored segments of the track, initialization segments included: positions 0 … segments−1. */
  segments: number;
  /** Positions of initialization segments (fMP4/WebM): each applies to the media segments after it. */
  initIndexes: number[];
  /** Positions where the discontinuity sequence changes (timestamps or encoding may change there). */
  discontinuityIndexes: number[];
  /** Container of the media segments, as the manifest declares it (the first media segment's). */
  container: ContainerFormat;
  /** Sum of the media segments' durations, seconds. */
  durationSec: number;
  /** Audio tracks: name and language from the manifest. */
  name?: string;
  language?: string;
}

/** Container written by the merge. */
export const OUTPUT_CONTAINERS = ['mp4', 'mkv'] as const;
export type OutputContainer = (typeof OUTPUT_CONTAINERS)[number];

export const STREAM_KINDS = ['video', 'audio', 'subtitle', 'data'] as const;
export type StreamKind = (typeof STREAM_KINDS)[number];

/** One elementary stream as FFmpeg found it in the downloaded data. */
export interface MediaStreamInfo {
  kind: StreamKind;
  /** FFmpeg codec name: h264, hevc, av1, vp9, aac, mp3, ac3, opus… */
  codec: string;
  profile?: string;
  width?: number;
  height?: number;
  /** Frames per second. */
  frameRate?: number;
  channels?: number;
  /** Hz. */
  sampleRate?: number;
  language?: string;
}

/** What FFmpeg found in one track's stored data. */
export interface TrackAnalysis {
  trackId: string;
  trackType: TrackType;
  /** Audio tracks: the manifest's name. */
  name?: string;
  /** FFmpeg demuxer that read the data: "mpegts", "mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm", "aac"… */
  format: string;
  /** Duration FFmpeg reports (estimated for MPEG-TS), seconds. */
  durationSec?: number;
  /** Start time of the track's first audio or video sample, seconds (may be negative: encoder delay). */
  startSec?: number;
  bytes: number;
  segments: number;
  streams: MediaStreamInfo[];
}

/** Result of media analysis: the downloaded tracks, checked by FFmpeg, and the container the merge will write. */
export interface MediaAnalysis {
  analysedAt: number;
  tracks: TrackAnalysis[];
  container: OutputContainer;
  /** Why `auto` chose MKV over MP4. */
  containerReason?: string;
}
