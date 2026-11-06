import { cleanText, METADATA_LIMITS, type FrameMetadata, type VideoElementInfo } from '@/shared/types/page-metadata';
import { isRecord } from '@/shared/utils/guards';

/**
 * Reads title information from the current frame. Only reads the DOM and
 * parses JSON-LD as data (JSON.parse); nothing from the page is executed.
 */

const MAX_JSON_LD_SCRIPTS = 10;
const MAX_JSON_LD_LENGTH = 200_000;

function metaContent(doc: Document, selector: string): string | undefined {
  return cleanText(doc.querySelector<HTMLMetaElement>(selector)?.content);
}

function isVideoObject(node: Record<string, unknown>): boolean {
  const type = node['@type'];
  return type === 'VideoObject' || (Array.isArray(type) && type.includes('VideoObject'));
}

/** Depth-first search for a schema.org VideoObject name in parsed JSON-LD. */
function findVideoObjectName(value: unknown, depth = 0): string | undefined {
  if (depth > 6) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const name = findVideoObjectName(item, depth + 1);
      if (name !== undefined) return name;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (isVideoObject(value)) {
    const name = cleanText(value['name']);
    if (name !== undefined) return name;
  }
  for (const key of ['@graph', 'video', 'mainEntity', 'itemListElement']) {
    const name = findVideoObjectName(value[key], depth + 1);
    if (name !== undefined) return name;
  }
  return undefined;
}

export function structuredVideoTitle(doc: Document): string | undefined {
  const scripts = [...doc.querySelectorAll('script[type="application/ld+json"]')].slice(0, MAX_JSON_LD_SCRIPTS);
  for (const script of scripts) {
    const text = script.textContent;
    if (text.length === 0 || text.length > MAX_JSON_LD_LENGTH) continue;
    try {
      const name = findVideoObjectName(JSON.parse(text));
      if (name !== undefined) return name;
    } catch {
      // Malformed JSON-LD is common; ignore it.
    }
  }
  return undefined;
}

function labelledByText(doc: Document, element: Element): string | undefined {
  const ids = element.getAttribute('aria-labelledby')?.split(/\s+/) ?? [];
  const text = ids.map((id) => doc.getElementById(id)?.textContent ?? '').join(' ');
  return cleanText(text);
}

export function describeVideoElement(doc: Document, video: HTMLVideoElement): VideoElementInfo {
  const info: VideoElementInfo = {};
  const title =
    cleanText(video.getAttribute('title')) ??
    cleanText(video.getAttribute('aria-label')) ??
    labelledByText(doc, video) ??
    cleanText(video.closest('figure')?.querySelector('figcaption')?.textContent);
  if (title !== undefined) info.title = title;
  if (Number.isFinite(video.duration) && video.duration > 0) info.duration = video.duration;
  if (video.videoWidth > 0) info.width = video.videoWidth;
  if (video.videoHeight > 0) info.height = video.videoHeight;
  return info;
}

export function collectFrameMetadata(doc: Document, win: Window): FrameMetadata {
  const metadata: FrameMetadata = {
    url: win.location.href,
    isTopFrame: win.top === win,
    videos: [...doc.querySelectorAll('video')]
      .slice(0, METADATA_LIMITS.maxVideos)
      .map((video) => describeVideoElement(doc, video)),
  };
  const documentTitle = cleanText(doc.title);
  const socialTitle =
    metaContent(doc, 'meta[property="og:title"]') ?? metaContent(doc, 'meta[name="twitter:title"]');
  const structuredTitle = structuredVideoTitle(doc);
  if (documentTitle !== undefined) metadata.documentTitle = documentTitle;
  if (socialTitle !== undefined) metadata.socialTitle = socialTitle;
  if (structuredTitle !== undefined) metadata.structuredTitle = structuredTitle;
  return metadata;
}
