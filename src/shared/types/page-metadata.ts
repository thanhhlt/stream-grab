import type { StreamingProtocol } from '@/core/models/detected-stream';
import { isRecord } from '@/shared/utils/guards';
import { parseHttpUrl } from '@/shared/utils/url';

/**
 * Data reported by the content script. It is read from page-controlled DOM in a
 * renderer that also runs untrusted page code, so the service worker validates
 * and bounds everything with the parse functions below before using it.
 */

export interface VideoElementInfo {
  title?: string;
  /** Seconds; only finite positive values. */
  duration?: number;
  width?: number;
  height?: number;
}

export interface FrameMetadata {
  url: string;
  isTopFrame: boolean;
  documentTitle?: string;
  /** og:title / twitter:title */
  socialTitle?: string;
  /** name of a schema.org VideoObject in JSON-LD */
  structuredTitle?: string;
  videos: VideoElementInfo[];
}

/** A manifest URL referenced directly by a <video> or <source> element. */
export interface DomSource {
  url: string;
  protocol: StreamingProtocol;
  /** Title of the referencing <video> element: an exact association, unlike frame-level titles. */
  title?: string;
}

export const METADATA_LIMITS = {
  maxTextLength: 300,
  maxVideos: 50,
  maxSources: 50,
  maxUrlLength: 4096,
} as const;

/** Trims, collapses whitespace, strips control characters, caps length; undefined when empty. */
export function cleanText(value: unknown, maxLength: number = METADATA_LIMITS.maxTextLength): string | undefined {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

function positiveNumber(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max ? value : undefined;
}

function parseVideoInfo(raw: unknown): VideoElementInfo | null {
  if (!isRecord(raw)) return null;
  const info: VideoElementInfo = {};
  const title = cleanText(raw['title']);
  const duration = positiveNumber(raw['duration'], 7 * 24 * 3600);
  const width = positiveNumber(raw['width'], 16384);
  const height = positiveNumber(raw['height'], 16384);
  if (title !== undefined) info.title = title;
  if (duration !== undefined) info.duration = duration;
  if (width !== undefined) info.width = Math.round(width);
  if (height !== undefined) info.height = Math.round(height);
  return info;
}

export function parseFrameMetadata(raw: unknown): FrameMetadata | null {
  if (!isRecord(raw) || typeof raw['url'] !== 'string' || raw['url'].length > METADATA_LIMITS.maxUrlLength) {
    return null;
  }
  const videos = Array.isArray(raw['videos'])
    ? raw['videos']
        .slice(0, METADATA_LIMITS.maxVideos)
        .map(parseVideoInfo)
        .filter((video) => video !== null)
    : [];
  const metadata: FrameMetadata = { url: raw['url'], isTopFrame: raw['isTopFrame'] === true, videos };
  const documentTitle = cleanText(raw['documentTitle']);
  const socialTitle = cleanText(raw['socialTitle']);
  const structuredTitle = cleanText(raw['structuredTitle']);
  if (documentTitle !== undefined) metadata.documentTitle = documentTitle;
  if (socialTitle !== undefined) metadata.socialTitle = socialTitle;
  if (structuredTitle !== undefined) metadata.structuredTitle = structuredTitle;
  return metadata;
}

export function parseDomSources(raw: unknown): DomSource[] {
  if (!isRecord(raw) || !Array.isArray(raw['sources'])) return [];
  const sources: DomSource[] = [];
  for (const item of raw['sources'].slice(0, METADATA_LIMITS.maxSources)) {
    if (!isRecord(item)) continue;
    const { url, protocol } = item;
    if (typeof url !== 'string' || url.length > METADATA_LIMITS.maxUrlLength || !parseHttpUrl(url)) continue;
    if (protocol !== 'hls' && protocol !== 'dash') continue;
    const title = cleanText(item['title']);
    sources.push(title === undefined ? { url, protocol } : { url, protocol, title });
  }
  return sources;
}
