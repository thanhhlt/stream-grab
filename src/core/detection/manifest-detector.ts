import type { StreamingProtocol } from '@/core/models/detected-stream';
import { parseHttpUrl, pathExtension } from '@/shared/utils/url';

/**
 * Classifies an observed network response as a streaming manifest, a candidate
 * worth sniffing, or something to ignore. Pure: no I/O.
 *
 * Signals, strongest first:
 *  1. Content-Type (HLS / DASH MIME types) — works for extensionless URLs.
 *  2. Content-Type that rules a manifest out (segments, images, HTML, JSON…).
 *  3. The path extension (.m3u8 / .m3u / .mpd) when the Content-Type is generic or missing.
 *  4. Format hints elsewhere in the URL (Azure `format=m3u8-aapl`, proxied `?url=…/x.m3u8`).
 *  5. Manifest keywords (manifest, playlist, master…) with a generic Content-Type → sniff the body.
 * Segment and asset extensions (.ts, .m4s, .mp4, .vtt, .key, …) are never manifests.
 */

export interface ResponseObservation {
  url: string;
  method: string;
  /** chrome.webRequest resource type. */
  resourceType: string;
  statusCode: number;
  contentType?: string | undefined;
  contentLength?: number | undefined;
}

export type ManifestEvidence = 'content-type' | 'extension' | 'url-hint';

export type IgnoreReason =
  | 'method'
  | 'resource-type'
  | 'status'
  | 'not-http'
  | 'too-large'
  | 'segment'
  | 'content-type'
  | 'no-signal';

export type ManifestVerdict =
  | { kind: 'manifest'; protocol: StreamingProtocol; evidence: ManifestEvidence }
  | { kind: 'probe' }
  | { kind: 'ignore'; reason: IgnoreReason };

/** Resource types a page uses to load manifests: XHR/fetch (MSE players), media (native playback), other. */
export const OBSERVED_RESOURCE_TYPES = ['xmlhttprequest', 'media', 'other'] as const;
/** Only script-driven loads are sniffed; native media requests carry reliable types. */
const PROBE_RESOURCE_TYPES = new Set(['xmlhttprequest', 'other']);

/** Manifests are text; anything bigger than this is media. */
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

export type MimeClass = StreamingProtocol | 'generic' | 'other';

const HLS_MIME = /^(?:application|audio|video)\/(?:x-|vnd\.apple\.)?mpegurl$/;
const DASH_MIME = new Set(['application/dash+xml', 'video/vnd.mpeg.dash.mpd']);
/** Types servers use when they do not know better; the body may still be a manifest. */
const GENERIC_MIME = new Set([
  '',
  'text/plain',
  'application/octet-stream',
  'binary/octet-stream',
  'application/binary',
  'application/x-binary',
  'application/unknown',
  'application/x-unknown',
  'application/download',
  'application/force-download',
  'application/xml',
  'text/xml',
]);

export function mimeEssence(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

export function classifyMimeType(contentType: string | undefined): MimeClass {
  const essence = mimeEssence(contentType);
  if (HLS_MIME.test(essence)) return 'hls';
  if (DASH_MIME.has(essence)) return 'dash';
  if (GENERIC_MIME.has(essence)) return 'generic';
  return 'other';
}

const MANIFEST_EXTENSIONS: Record<string, StreamingProtocol> = { m3u8: 'hls', m3u: 'hls', mpd: 'dash' };

/** Media segments, subtitles, keys and page assets: never manifests. */
const NON_MANIFEST_EXTENSIONS = new Set([
  // media segments and progressive files
  'ts', 'm2ts', 'mts', 'm4s', 'm4f', 'mp4', 'm4v', 'm4a', 'mp3', 'aac', 'ac3', 'ec3', 'eac3', 'flac', 'opus', 'ogg',
  'webm', 'mkv', 'mov', 'cmfv', 'cmfa', 'cmft', 'fmp4', 'init', 'bin',
  // subtitles, keys
  'vtt', 'webvtt', 'srt', 'ttml', 'dfxp', 'key',
  // page assets
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'ico', 'js', 'mjs', 'css', 'json', 'html', 'htm', 'wasm',
  'woff', 'woff2', 'ttf', 'otf', 'map',
]); // prettier-ignore

const MANIFEST_KEYWORDS = new Set(['m3u8', 'm3u', 'mpd', 'manifest', 'playlist', 'playlists', 'master', 'hls', 'dash', 'cmaf']);

function decodedTail(url: URL): string {
  const tail = `${url.pathname}${url.search}`;
  try {
    return decodeURIComponent(tail).toLowerCase();
  } catch {
    return tail.toLowerCase();
  }
}

/** Protocol named by the URL itself, if any. */
export function protocolFromUrl(url: URL): { protocol: StreamingProtocol; evidence: 'extension' | 'url-hint' } | null {
  const fromExtension = MANIFEST_EXTENSIONS[pathExtension(url)];
  if (fromExtension) return { protocol: fromExtension, evidence: 'extension' };
  const tail = decodedTail(url);
  if (/\.m3u8(?![a-z0-9])/.test(tail) || /[?&(,;]format=(?:m3u8|hls)/.test(tail)) {
    return { protocol: 'hls', evidence: 'url-hint' };
  }
  if (/\.mpd(?![a-z0-9])/.test(tail) || /[?&(,;]format=(?:mpd|dash)/.test(tail)) {
    return { protocol: 'dash', evidence: 'url-hint' };
  }
  return null;
}

export function isNonManifestUrl(url: URL): boolean {
  return NON_MANIFEST_EXTENSIONS.has(pathExtension(url));
}

export function hasManifestKeyword(url: URL): boolean {
  return decodedTail(url)
    .split(/[^a-z0-9]+/)
    .some((token) => MANIFEST_KEYWORDS.has(token));
}

function acceptableStatus(status: number): boolean {
  return (status >= 200 && status < 300 && status !== 204 && status !== 205) || status === 304;
}

export function classifyResponse(observation: ResponseObservation): ManifestVerdict {
  if (observation.method.toUpperCase() !== 'GET') return { kind: 'ignore', reason: 'method' };
  if (!(OBSERVED_RESOURCE_TYPES as readonly string[]).includes(observation.resourceType)) {
    return { kind: 'ignore', reason: 'resource-type' };
  }
  if (!acceptableStatus(observation.statusCode)) return { kind: 'ignore', reason: 'status' };
  const url = parseHttpUrl(observation.url);
  if (!url) return { kind: 'ignore', reason: 'not-http' };
  if (observation.contentLength !== undefined && observation.contentLength > MAX_MANIFEST_BYTES) {
    return { kind: 'ignore', reason: 'too-large' };
  }

  // A 304 carries no Content-Type; judge it by URL only.
  const mime = observation.statusCode === 304 ? 'generic' : classifyMimeType(observation.contentType);
  if (mime === 'hls' || mime === 'dash') return { kind: 'manifest', protocol: mime, evidence: 'content-type' };
  if (mime === 'other') return { kind: 'ignore', reason: 'content-type' };

  if (isNonManifestUrl(url)) return { kind: 'ignore', reason: 'segment' };
  const fromUrl = protocolFromUrl(url);
  if (fromUrl) return { kind: 'manifest', protocol: fromUrl.protocol, evidence: fromUrl.evidence };
  if (PROBE_RESOURCE_TYPES.has(observation.resourceType) && hasManifestKeyword(url)) return { kind: 'probe' };
  return { kind: 'ignore', reason: 'no-signal' };
}
