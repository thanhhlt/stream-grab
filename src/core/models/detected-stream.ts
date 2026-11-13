/** Protocols whose media comes in segments listed by a manifest; each has a protocol adapter. */
export const STREAMING_PROTOCOLS = ['hls', 'dash'] as const;
export type StreamingProtocol = (typeof STREAMING_PROTOCOLS)[number];

/**
 * Every kind of video StreamGrab lists: the streaming protocols, plus
 * `progressive` (since 0.3.0): one plain media file (MP4, WebM) that a
 * media element plays while it downloads and that is saved as it is.
 */
export const MEDIA_PROTOCOLS = [...STREAMING_PROTOCOLS, 'progressive'] as const;
export type MediaProtocol = (typeof MEDIA_PROTOCOLS)[number];

export const PROGRESSIVE_CONTAINERS = ['mp4', 'webm'] as const;
export type ProgressiveContainer = (typeof PROGRESSIVE_CONTAINERS)[number];

/** The one "quality" of a progressive file (the selection model expects a variant). */
export const PROGRESSIVE_VARIANT_ID = 'file';

/** What is known about a progressive file: from the page's request, then from inspecting the file. */
export interface ProgressiveInfo {
  /** Confirmed from the file's first bytes once inspected; before that, from the Content-Type or extension. */
  container: ProgressiveContainer;
  /** Content-Type the server declared (essence, lower case), e.g. "video/mp4" or "application/octet-stream". */
  mimeType?: string;
  /** File size in bytes (Content-Range total or Content-Length); absent when the server does not say. */
  bytes?: number;
  /** The server answered a byte-range request with 206 Partial Content. */
  acceptsRanges?: boolean;
  /** Name the server suggests (Content-Disposition) or the last path segment of the URL. */
  fileName?: string;
}

/**
 * Why a stream was recognised:
 * - `content-type`: the response declared an HLS/DASH (or MP4/WebM) MIME type
 * - `extension`:    .m3u8 / .m3u / .mpd path (.mp4 / .m4v / .webm for progressive files)
 * - `url-hint`:     manifest format hints elsewhere in the URL (format=m3u8-aapl, ?url=…/x.m3u8)
 * - `content`:      the body was sniffed (extensionless URL with a generic Content-Type)
 * - `dom`:          a <video>/<source> element points at a manifest or media file
 */
export const DETECTION_EVIDENCE = ['content-type', 'extension', 'url-hint', 'content', 'dom'] as const;
export type DetectionEvidence = (typeof DETECTION_EVIDENCE)[number];

/**
 * - `pending`: seen, manifest inspection not finished
 * - `ready`:   inspected, downloadable
 * - `drm`:     protected by a DRM system; never downloaded
 * - `error`:   inspection failed (HTTP error, expired link, timeout)
 */
export const DETECTION_STATUSES = ['pending', 'ready', 'drm', 'error'] as const;
export type DetectionStatus = (typeof DETECTION_STATUSES)[number];

export const DRM_SYSTEMS = ['widevine', 'playready', 'fairplay', 'clearkey', 'unknown'] as const;
export type DrmSystem = (typeof DRM_SYSTEMS)[number];

/** `aes-128` and `sample-aes` (identity key format) use keys the page can fetch; `cenc` is DASH Common Encryption. */
export const ENCRYPTION_KINDS = ['none', 'aes-128', 'sample-aes', 'cenc'] as const;
export type EncryptionKind = (typeof ENCRYPTION_KINDS)[number];

export const MANIFEST_ROLES = ['master', 'media', 'presentation'] as const;
/** HLS multivariant ("master") or media playlist; DASH MPDs are a `presentation`. */
export type ManifestRole = (typeof MANIFEST_ROLES)[number];

/**
 * Headers of the page's own manifest request that are replayed on the
 * extension's requests. Allow-listed: never cookies or authorization headers
 * (the browser attaches cookies itself). Kept only in chrome.storage.session.
 */
export interface RequestContext {
  referer?: string;
  origin?: string;
}

export function isEmptyRequestContext(context: RequestContext): boolean {
  return context.referer === undefined && context.origin === undefined;
}

/** Equality key for request contexts. */
export function requestContextKey(context: RequestContext): string {
  return `referer=${context.referer ?? ''}\norigin=${context.origin ?? ''}`;
}

/** What a lightweight look at the manifest text revealed (full parsing happens in the protocol adapters). */
export interface ManifestSummary {
  role: ManifestRole;
  live: boolean;
  drmSystems: DrmSystem[];
  encryption: EncryptionKind;
}

/** One quality as shown in the stream list (persisted, so kept small). */
export interface VariantSummary {
  /** VideoVariant.id in the parsed manifest; sent back when the user picks this quality. */
  id: string;
  width?: number;
  height?: number;
  bandwidth?: number;
  frameRate?: number;
  videoCodec?: string;
  audioCodec?: string;
  audioOnly: boolean;
  /** Alternative audio tracks that may be combined with this quality. */
  audioTrackIds: string[];
  /** Subtitle tracks that may be saved with this quality (0.7.0). */
  subtitleTrackIds?: string[];
}

export interface AudioTrackSummary {
  /** AudioTrack.id in the parsed manifest. */
  id: string;
  name: string;
  language?: string;
  isDefault: boolean;
  codec?: string;
}

/** A WebVTT subtitle track (0.7.0). */
export interface SubtitleTrackSummary {
  /** SubtitleTrack.id in the parsed manifest; for a progressive file, `track-N`; a page subtitle file (0.7.2), `page-N`. */
  id: string;
  name: string;
  language?: string;
  isDefault: boolean;
  forced?: boolean;
  /** The WebVTT file: a progressive file's `<track src>`, or a page subtitle file (any protocol). */
  url?: string;
  /** Page subtitle files (0.7.2): seconds the page's player adds to the file's cue times (found from its text tracks). */
  offsetSec?: number;
}

/**
 * Ids of page subtitle files (0.7.2): WebVTT files a player loaded on its
 * own, offered with every video of the page. Manifest renditions and
 * `<track>`s never use this prefix.
 */
export const PAGE_SUBTITLE_PREFIX = 'page-';

export function isPageSubtitleId(id: string): boolean {
  return id.startsWith(PAGE_SUBTITLE_PREFIX);
}

/** What parsing the manifest revealed about the media (HLS and DASH). */
export interface MediaSummary {
  /** Seconds; absent for live streams or when no media playlist could be read. */
  durationSec?: number;
  /** Best first. */
  variants: VariantSummary[];
  audioTracks: AudioTrackSummary[];
  /** WebVTT subtitles (0.7.0): manifest renditions, or a progressive file's `<track>` elements. */
  subtitleTracks?: SubtitleTrackSummary[];
}

export interface DetectedStream {
  /** Stable within a tab: derived from `dedupeKey`. */
  id: string;
  tabId: number;
  /** Frame whose request loaded the manifest (0 = top frame). */
  frameId: number;
  protocol: MediaProtocol;
  /** Most recently seen manifest (or progressive file) URL (keeps the freshest signed token). */
  url: string;
  /** URL without volatile query parameters (tokens, cache busters); identical manifests share it. */
  dedupeKey: string;
  evidence: DetectionEvidence[];
  status: DetectionStatus;
  statusMessage?: string;
  manifest?: ManifestSummary;
  /** Qualities, duration and audio tracks from the parsed manifest (a progressive file: its one variant). */
  media?: MediaSummary;
  /** Progressive files only. */
  progressive?: ProgressiveInfo;
  /**
   * Progressive files (0.7.0): the `<track>` subtitles its <video> element last reported, kept from
   * before the file is inspected (they are listed in `media` once it is).
   */
  domSubtitles?: SubtitleTrackSummary[];
  /** Dedupe keys of playlists referenced by an HLS master; they are not listed as separate videos. */
  childKeys?: string[];
  /** Top-level page URL when the stream was detected. */
  pageUrl?: string;
  pageTitle?: string;
  /** Best title found for this stream (video element, structured data, page title). */
  title?: string;
  /** Duration of the frame's only <video> element, when unambiguous. Seconds. */
  durationHint?: number;
  requestContext: RequestContext;
  firstSeen: number;
  lastSeen: number;
  inspectedAt?: number;
}
