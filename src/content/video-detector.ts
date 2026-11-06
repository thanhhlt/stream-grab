import { classifyMimeType, progressiveContainer, protocolFromUrl } from '@/core/detection/manifest-detector';
import { METADATA_LIMITS, type DomSource } from '@/shared/types/page-metadata';
import { parseHttpUrl } from '@/shared/utils/url';
import { describeVideoElement } from './page-metadata';

/**
 * Finds manifests and progressive files (MP4/WebM, since 0.3.0) referenced
 * directly by media elements (`<video src="….m3u8">`,
 * `<source type="application/dash+xml">`, `<video src="clip.mp4">`). This
 * catches videos before they are played (preload="none") and sites that rely
 * on native HLS playback. MSE players expose only blob: URLs here; those are
 * caught by network monitoring instead.
 */

const SOURCE_SELECTOR = 'video[src], video source[src]';

export function findDomSources(root: ParentNode, baseUrl: string): DomSource[] {
  const found = new Map<string, DomSource>();
  for (const element of root.querySelectorAll(SOURCE_SELECTOR)) {
    if (found.size >= METADATA_LIMITS.maxSources) break;
    const raw = element.getAttribute('src');
    if (!raw) continue;
    const url = parseHttpUrl(raw, baseUrl); // drops blob:, data:, mediastream:
    if (!url || url.href.length > METADATA_LIMITS.maxUrlLength) continue;
    if (found.has(url.href)) continue;
    const type = element.getAttribute('type') ?? undefined;
    const declared = classifyMimeType(type);
    const protocol = declared === 'hls' || declared === 'dash' ? declared : protocolFromUrl(url)?.protocol;
    const file = protocol ? null : progressiveContainer(url, type);
    let source: DomSource;
    if (protocol) source = { url: url.href, protocol };
    else if (file) source = { url: url.href, protocol: 'progressive', container: file.container };
    else continue;
    const video = element instanceof HTMLVideoElement ? element : element.closest('video');
    const title = video ? describeVideoElement(video.ownerDocument, video).title : undefined;
    if (title !== undefined) source.title = title;
    found.set(url.href, source);
  }
  return [...found.values()];
}

export interface DomSourceWatcher {
  stop(): void;
}

/**
 * Reports media-element manifests now and whenever the DOM changes. Changes
 * are batched (one scan per `debounceMs`) and each URL is reported once.
 */
export function watchDomSources(
  doc: Document,
  report: (sources: DomSource[]) => void,
  debounceMs = 500,
): DomSourceWatcher {
  const reported = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const scan = (): void => {
    timer = undefined;
    const fresh = findDomSources(doc, doc.baseURI).filter((source) => !reported.has(source.url));
    if (fresh.length === 0) return;
    for (const source of fresh) reported.add(source.url);
    report(fresh);
  };

  const observer = new MutationObserver(() => {
    timer ??= setTimeout(scan, debounceMs);
  });
  observer.observe(doc.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['src', 'type'],
  });
  scan();

  return {
    stop() {
      observer.disconnect();
      clearTimeout(timer);
    },
  };
}
