import { classifyMimeType, progressiveContainer, protocolFromUrl } from '@/core/detection/manifest-detector';
import { METADATA_LIMITS, type DomSource, type DomSubtitle } from '@/shared/types/page-metadata';
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

/** WebVTT `<track>` elements of a video (0.7.0); `kind` defaults to subtitles. */
export function findTrackSubtitles(video: HTMLVideoElement, baseUrl: string): DomSubtitle[] {
  const subtitles: DomSubtitle[] = [];
  for (const track of video.querySelectorAll('track[src]')) {
    if (subtitles.length >= METADATA_LIMITS.maxSubtitles) break;
    const kind = (track.getAttribute('kind') ?? 'subtitles').trim().toLowerCase();
    if (kind !== 'subtitles' && kind !== 'captions') continue;
    const url = parseHttpUrl(track.getAttribute('src') ?? '', baseUrl);
    if (!url || url.href.length > METADATA_LIMITS.maxUrlLength) continue;
    const subtitle: DomSubtitle = { url: url.href, isDefault: track.hasAttribute('default') };
    const language = track.getAttribute('srclang')?.trim();
    const label = track.getAttribute('label')?.trim();
    if (language) subtitle.language = language;
    if (label) subtitle.label = label;
    subtitles.push(subtitle);
  }
  return subtitles;
}

/** Changes when a source's own report changes (a player adding `<track>` elements after `src`). */
const reportKey = (source: DomSource) => `${source.url}\n${JSON.stringify(source.subtitles ?? [])}`;

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
    // Always sent for a file inside a <video>, also empty: tracks a player removed must disappear.
    if (video && source.protocol === 'progressive') source.subtitles = findTrackSubtitles(video, baseUrl);
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
  /** Last report per URL: a source is sent again when its own report changes (tracks added or removed). */
  const reported = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const scan = (): void => {
    timer = undefined;
    const fresh = findDomSources(doc, doc.baseURI).filter((source) => reported.get(source.url) !== reportKey(source));
    if (fresh.length === 0) return;
    for (const source of fresh) reported.set(source.url, reportKey(source));
    report(fresh);
  };

  const observer = new MutationObserver(() => {
    timer ??= setTimeout(scan, debounceMs);
  });
  observer.observe(doc.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['src', 'type', 'kind', 'srclang', 'label'],
  });
  scan();

  return {
    stop() {
      observer.disconnect();
      clearTimeout(timer);
    },
  };
}
