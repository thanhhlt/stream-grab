export const STREAMING_PROTOCOLS = ['hls', 'dash'] as const;
export type StreamingProtocol = (typeof STREAMING_PROTOCOLS)[number];

/**
 * Why a stream was recognised:
 * - `content-type`: the response declared an HLS/DASH MIME type
 * - `extension`:    .m3u8 / .m3u / .mpd path
 * - `url-hint`:     manifest format hints elsewhere in the URL (format=m3u8-aapl, ?url=…/x.m3u8)
 * - `content`:      the body was sniffed (extensionless URL with a generic Content-Type)
 * - `dom`:          a <video>/<source> element points at a manifest
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
}

export interface AudioTrackSummary {
  /** AudioTrack.id in the parsed manifest. */
  id: string;
  name: string;
  language?: string;
  isDefault: boolean;
  codec?: string;
}

/** What parsing the manifest revealed about the media (HLS and DASH). */
export interface MediaSummary {
  /** Seconds; absent for live streams or when no media playlist could be read. */
  durationSec?: number;
  /** Best first. */
  variants: VariantSummary[];
  audioTracks: AudioTrackSummary[];
}

export interface DetectedStream {
  /** Stable within a tab: derived from `dedupeKey`. */
  id: string;
  tabId: number;
  /** Frame whose request loaded the manifest (0 = top frame). */
  frameId: number;
  protocol: StreamingProtocol;
  /** Most recently seen manifest URL (keeps the freshest signed token). */
  url: string;
  /** URL without volatile query parameters (tokens, cache busters); identical manifests share it. */
  dedupeKey: string;
  evidence: DetectionEvidence[];
  status: DetectionStatus;
  statusMessage?: string;
  manifest?: ManifestSummary;
  /** Qualities, duration and audio tracks from the parsed manifest. */
  media?: MediaSummary;
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
