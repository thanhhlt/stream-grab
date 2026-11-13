import {
  isEmptyRequestContext,
  isPageSubtitleId,
  PAGE_SUBTITLE_PREFIX,
  PROGRESSIVE_VARIANT_ID,
  requestContextKey,
  type DetectedStream,
  type DetectionEvidence,
  type MediaProtocol,
  type ProgressiveInfo,
  type RequestContext,
  type SubtitleTrackSummary,
} from '@/core/models/detected-stream';
import { languageKey } from '@/core/media/languages';
import { describeDrm } from '@/core/protocols/drm';
import { createLimiter, type Limiter } from '@/shared/utils/concurrency';
import { errorMessage } from '@/shared/utils/errors';
import { stableHash } from '@/shared/utils/hash';
import type { Logger } from '@/shared/utils/logger';
import { dedupeKey, fileNameOf, parseHttpUrl, urlShape } from '@/shared/utils/url';
import { involvesBlockedSite, isBlockedUrl } from './blocked-sites';
import type { DetectionStore, StoredTabDetections } from './detection-store';
import type { ManifestInfo } from './manifest-inspector';
import type { InspectionKind, InspectionOutcome } from './stream-inspector';
import type { SubtitleFileInspection } from './subtitle-inspector';
import { cueOffsetSec } from '@/core/subtitles/cue-offset';
import type { PageCue, PageTextTrack } from '@/shared/types/text-tracks';

/** A possible manifest or progressive file observed in a tab (network request or DOM element). */
export interface DetectionCandidate {
  tabId: number;
  frameId: number;
  url: string;
  /** Known protocol and the evidence for it; absent when the body must be sniffed before listing. */
  match?: { protocol: MediaProtocol; evidence: DetectionEvidence };
  /** Progressive files: what the request revealed (container from Content-Type or extension). Required with that protocol. */
  progressive?: ProgressiveInfo;
  requestContext: RequestContext;
  timestamp: number;
  /** Title known exactly for this URL (its own <video> element); wins over frame-level titles. */
  title?: string;
  /** Progressive files (0.7.0): WebVTT `<track>` elements of the referencing <video>. */
  subtitles?: SubtitleTrackSummary[];
}

/** A WebVTT file a page loaded on its own (0.7.2), offered with every video of the tab once checked. */
export interface SubtitleFileCandidate {
  tabId: number;
  /** Frame whose request loaded the file: its player is asked how it times the cues. */
  frameId: number;
  url: string;
  requestContext: RequestContext;
  timestamp: number;
}

export interface PageInfo {
  pageUrl?: string;
  pageTitle?: string;
  title?: string;
  durationHint?: number;
}

export interface DetectionLimits {
  maxStreamsPerTab: number;
  /** Content probes (extensionless URLs with generic Content-Type) per page load. */
  maxProbesPerPage: number;
  /** A failed inspection is retried when the page requests the manifest again, at most this often. */
  retryFailedAfterMs: number;
  /** Page subtitle files offered per page (0.7.2). */
  maxSubtitleFilesPerTab: number;
  /** WebVTT files fetched per page to check them (segments of a rendition are rejected but still cost a request). */
  maxSubtitleChecksPerPage: number;
}

export const DEFAULT_DETECTION_LIMITS: Readonly<DetectionLimits> = {
  maxStreamsPerTab: 100,
  maxProbesPerPage: 40,
  retryFailedAfterMs: 5_000,
  maxSubtitleFilesPerTab: 8,
  maxSubtitleChecksPerPage: 30,
};

export interface DetectionManagerOptions {
  store: DetectionStore;
  inspect: (url: string, context: RequestContext, kind: InspectionKind) => Promise<InspectionOutcome>;
  resolvePageInfo: (tabId: number, frameId: number) => Promise<PageInfo>;
  /** Fetches and checks a page subtitle file (0.7.2); without it such files are ignored. */
  inspectSubtitle?: (url: string, context: RequestContext) => Promise<SubtitleFileInspection>;
  /** The first cues of a frame's <video> text tracks (0.7.2): how its player times a page subtitle file. */
  readTextTracks?: (tabId: number, frameId: number) => Promise<PageTextTrack[]>;
  /**
   * The tab's current URL (0.8.0), asked before anything new is fetched: the URL kept from the last
   * navigation may be missing (worker restarted, extension updated) or stale (prerender, back/forward cache).
   */
  getTabUrl?: (tabId: number) => Promise<string | undefined>;
  /** When to ask the player for its cues after a page subtitle file was found (it adds them after loading it). */
  cueCheckDelaysMs?: readonly number[];
  /** Called after a tab's detections were persisted (badge updates). */
  onTabChanged?: (tabId: number, streams: readonly DetectedStream[]) => void;
  now?: () => number;
  inspectionConcurrency?: number;
  flushDelayMs?: number;
  limits?: Partial<DetectionLimits>;
  logger?: Logger;
}

interface TabState {
  tabId: number;
  generation: number;
  pageUrl: string | undefined;
  streams: Map<string, DetectedStream>;
  /** URL shapes whose content probe found no manifest (segments of one stream share a shape). */
  probedShapes: Set<string>;
  /** URL shapes of media-element requests that turned out to be segments, not files (native HLS playback). */
  segmentShapes: Set<string>;
  /** `liveKey`s of live manifests (and of a live master's playlists): never listed nor fetched again until the next page. */
  liveKeys: Set<string>;
  probes: number;
  inspecting: Set<string>;
  /** Dedupe keys the user removed; ignored until the next navigation. */
  dismissedKeys: Set<string>;
  /** Page subtitle files (0.7.2), ids `page-N` in the order found; offered with every video of the page. */
  subtitleFiles: SubtitleTrackSummary[];
  /** Dedupe keys of WebVTT files checked (or being checked) on this page. */
  subtitleKeys: Set<string>;
  /** Checks since the page loaded or the last new video (a single-page site moving to the next video). */
  subtitleChecks: number;
  /** URL shapes of numbered WebVTT files that are a rendition's segments. */
  subtitleRunShapes: Set<string>;
  /** Incremented on navigation only: checks started for an earlier page are discarded. */
  subtitleGeneration: number;
  /** Number of the next page file's id (`page-N`): ids are not reused within a page. */
  nextSubtitleId: number;
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Whether a record for this tab exists in the store. */
  persisted: boolean;
  removed: boolean;
}

function languageName(tag: string): string | undefined {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' }).of(tag);
    return name === undefined || name === '' ? undefined : name;
  } catch {
    return undefined;
  }
}

/** "Chinese", else the file's name ("captions.zh"); a second file of the same name gets a number. */
export function pageSubtitleName(existing: readonly SubtitleTrackSummary[], url: string, language: string | undefined): string {
  const fromFile = fileNameOf(url)
    .replace(/\.(?:web)?vtt(?:\.[^.]*)?$/i, '')
    .trim()
    .slice(0, 60);
  const base = (language === undefined ? undefined : languageName(language)) ?? (fromFile || `Subtitles ${existing.length + 1}`);
  const taken = new Set(existing.map((track) => track.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  }
}

export function streamIdFor(key: string): string {
  return `s${stableHash(key)}`;
}

/**
 * Host and exact path, without the query: a live player reloads its playlist
 * with a changing query (LL-HLS `_HLS_msn`, `t=`, tokens) that `dedupeKey`
 * keeps. Not `urlShape`, whose collapsed digits would also match a VOD such
 * as `/hls/456/index.m3u8` next to a live `/hls/123/index.m3u8`.
 */
export function liveKey(input: string): string {
  const url = parseHttpUrl(input);
  return url ? `${url.host}${url.pathname}` : input;
}

/**
 * Owns the per-tab list of detected streams.
 *
 * - Deduplicates by `dedupeKey` (URL without tokens/cache busters) and keeps
 *   the freshest URL and request context of each manifest.
 * - Inspects every new manifest once (bounded concurrency) to confirm the
 *   protocol and fold HLS variant/rendition playlists under their master, so
 *   one video is listed once even though the player loads several playlists.
 * - Live manifests are not listed (they cannot be downloaded yet) and their
 *   reloads are not fetched again until the next page (`#forgetLive`).
 * - Generation counter per tab: results of work started before a navigation
 *   are discarded.
 * - State is written through to the DetectionStore (debounced), so it survives
 *   service-worker restarts; streams still `pending` after a restart are
 *   re-inspected when the tab is next touched.
 */
export class DetectionManager {
  readonly #store: DetectionStore;
  readonly #inspect: DetectionManagerOptions['inspect'];
  readonly #resolvePageInfo: DetectionManagerOptions['resolvePageInfo'];
  readonly #getTabUrl: DetectionManagerOptions['getTabUrl'];
  readonly #inspectSubtitle: DetectionManagerOptions['inspectSubtitle'];
  readonly #readTextTracks: DetectionManagerOptions['readTextTracks'];
  readonly #cueCheckDelaysMs: readonly number[];
  readonly #onTabChanged: DetectionManagerOptions['onTabChanged'];
  readonly #now: () => number;
  readonly #limit: Limiter;
  readonly #flushDelayMs: number;
  readonly #limits: DetectionLimits;
  readonly #logger: Logger | undefined;

  readonly #tabs = new Map<number, Promise<TabState>>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #saveChains = new Map<number, Promise<void>>();

  constructor(options: DetectionManagerOptions) {
    this.#store = options.store;
    this.#inspect = options.inspect;
    this.#resolvePageInfo = options.resolvePageInfo;
    this.#getTabUrl = options.getTabUrl;
    this.#inspectSubtitle = options.inspectSubtitle;
    this.#readTextTracks = options.readTextTracks;
    this.#cueCheckDelaysMs = options.cueCheckDelaysMs ?? [1_000, 3_000, 8_000, 20_000, 60_000];
    this.#onTabChanged = options.onTabChanged;
    this.#now = options.now ?? Date.now;
    this.#limit = createLimiter(options.inspectionConcurrency ?? 3);
    this.#flushDelayMs = options.flushDelayMs ?? 100;
    this.#limits = { ...DEFAULT_DETECTION_LIMITS, ...options.limits };
    this.#logger = options.logger;
  }

  // ------------------------------------------------------------ public API

  handleCandidate(candidate: DetectionCandidate): Promise<void> {
    return this.#track(this.#handleCandidate(candidate));
  }

  /** A WebVTT file the page loaded on its own (0.7.2): checked once, then offered with the tab's videos. */
  handleSubtitleFile(file: SubtitleFileCandidate): Promise<void> {
    return this.#track(this.#handleSubtitleFile(file));
  }

  /** The tab navigated to a new document: forget everything detected for the previous one. */
  resetTab(tabId: number, pageUrl?: string): Promise<void> {
    return this.#track(
      (async () => {
        const tab = await this.#tab(tabId);
        this.#clear(tab);
        tab.subtitleFiles = [];
        tab.subtitleKeys.clear();
        tab.subtitleChecks = 0;
        tab.subtitleRunShapes.clear();
        tab.subtitleGeneration += 1;
        tab.nextSubtitleId = 0;
        tab.pageUrl = pageUrl;
        tab.dismissedKeys.clear();
        await this.#flushNow(tab);
      })(),
    );
  }

  /** User action: clear the list (removed items may reappear if the page loads them again). */
  clearTab(tabId: number): Promise<void> {
    return this.#track(
      (async () => {
        const tab = await this.#tab(tabId);
        this.#clear(tab);
        await this.#flushNow(tab);
      })(),
    );
  }

  /** User action: remove one stream; it stays hidden until the tab navigates. */
  removeStream(tabId: number, streamId: string): Promise<boolean> {
    return this.#track(
      (async () => {
        const tab = await this.#tab(tabId);
        const stream = tab.streams.get(streamId);
        if (!stream) return false;
        tab.streams.delete(streamId);
        tab.dismissedKeys.add(stream.dedupeKey);
        await this.#flushNow(tab);
        return true;
      })(),
    );
  }

  /** The tab was closed. */
  dropTab(tabId: number): Promise<void> {
    return this.#track(
      (async () => {
        const state = this.#tabs.get(tabId);
        this.#tabs.delete(tabId);
        if (state) {
          const tab = await state;
          tab.removed = true;
          clearTimeout(tab.flushTimer);
        }
        await this.#store.remove(tabId).catch((error: unknown) => {
          this.#logger?.warn('Could not remove tab detections', { tabId, error: errorMessage(error) });
        });
      })(),
    );
  }

  async getStreams(tabId: number): Promise<DetectedStream[]> {
    const tab = await this.#tab(tabId);
    return this.#visible(tab);
  }

  /** A copy of one stream, or undefined when it is not (or no longer) listed. */
  async getStream(tabId: number, streamId: string): Promise<DetectedStream | undefined> {
    const tab = await this.#tab(tabId);
    const stream = tab.streams.get(streamId);
    return stream ? structuredClone(stream) : undefined;
  }

  /** Resolves when no inspection, page-info lookup or write is outstanding (tests, shutdown). */
  async idle(): Promise<void> {
    for (;;) {
      for (const state of this.#tabs.values()) {
        const tab = await state;
        if (tab.flushTimer !== undefined) void this.#track(this.#flushNow(tab));
      }
      if (this.#pending.size === 0) return;
      await Promise.allSettled([...this.#pending]);
    }
  }

  // -------------------------------------------------------------- handling

  async #handleCandidate(candidate: DetectionCandidate): Promise<void> {
    if (!parseHttpUrl(candidate.url)) return;
    const tab = await this.#tab(candidate.tabId);
    if (tab.removed || this.#isBlocked(candidate.url, candidate.requestContext)) return;
    // Everything below runs without yielding, as before: a duplicate candidate cannot slip in between.
    if ((await this.#onBlockedPage(tab)) || tab.removed) return;
    const key = dedupeKey(candidate.url);
    if (tab.dismissedKeys.has(key) || this.#isChildKey(tab, key)) return;
    if (candidate.match?.protocol === 'progressive') {
      // Segments of one stream share a URL shape: once one was found to be a segment, skip the rest.
      if (!candidate.progressive || tab.segmentShapes.has(urlShape(candidate.url))) return;
    }
    const id = streamIdFor(key);
    const existing = tab.streams.get(id);
    if (existing) {
      this.#refresh(tab, existing, candidate);
      return;
    }
    // Reloads of a live manifest: not listed, not fetched again.
    if (tab.liveKeys.has(liveKey(candidate.url))) return;
    if (!candidate.match) {
      await this.#probe(tab, candidate, key, id);
      return;
    }
    this.#addStream(tab, candidate, key, id, candidate.match.protocol, candidate.match.evidence);
  }

  async #handleSubtitleFile(file: SubtitleFileCandidate): Promise<void> {
    const inspect = this.#inspectSubtitle;
    if (!inspect || !parseHttpUrl(file.url)) return;
    const tab = await this.#tab(file.tabId);
    if (tab.removed || this.#isBlocked(file.url, file.requestContext)) return;
    if ((await this.#onBlockedPage(tab)) || tab.removed) return;
    const key = dedupeKey(file.url);
    if (tab.subtitleKeys.has(key)) {
      // The same file again, maybe with a fresh token: keep the newest link.
      const known = tab.subtitleFiles.find((track) => track.url !== undefined && dedupeKey(track.url) === key);
      if (known && known.url !== file.url) {
        known.url = file.url;
        for (const stream of tab.streams.values()) this.#applySubtitles(tab, stream);
        this.#markDirty(tab);
      }
      return;
    }
    // Numbered files of one shape on a page whose video has subtitle renditions: that rendition's
    // segments (those without X-TIMESTAMP-MAP pass the content check), not files of their own.
    const shape = urlShape(file.url);
    if (tab.subtitleRunShapes.has(shape)) return;
    const hasRenditions = [...tab.streams.values()].some((stream) => stream.media?.subtitleTracks?.some((track) => track.url === undefined));
    if (hasRenditions && [...tab.subtitleKeys].some((known) => urlShape(known) === shape)) {
      tab.subtitleRunShapes.add(shape);
      const before = tab.subtitleFiles.length;
      tab.subtitleFiles = tab.subtitleFiles.filter((track) => track.url === undefined || urlShape(track.url) !== shape);
      if (tab.subtitleFiles.length !== before) {
        for (const stream of tab.streams.values()) this.#applySubtitles(tab, stream);
        this.#markDirty(tab);
      }
      return;
    }
    if (tab.subtitleChecks >= this.#limits.maxSubtitleChecksPerPage) return;
    tab.subtitleKeys.add(key);
    tab.subtitleChecks += 1;
    // Only a navigation drops page files: clearing the list (which also starts a new generation) keeps them.
    const generation = tab.subtitleGeneration;
    let result: SubtitleFileInspection;
    try {
      result = await this.#limit(() => inspect(file.url, file.requestContext));
    } catch (error) {
      result = { ok: false, reason: errorMessage(error), transient: true };
    }
    if (tab.removed || tab.subtitleGeneration !== generation) return;
    if (!result.ok) {
      // A file that could not be fetched is checked again when the page loads it again.
      if (result.transient) tab.subtitleKeys.delete(key);
      this.#logger?.debug('Ignoring a WebVTT file', { url: file.url, reason: result.reason });
      return;
    }
    if (tab.subtitleRunShapes.has(shape)) return;
    // Full: the oldest file goes (a single-page site's earlier videos); ids are never reused.
    while (tab.subtitleFiles.length >= this.#limits.maxSubtitleFilesPerTab) tab.subtitleFiles.shift();
    const track: SubtitleTrackSummary = {
      id: `${PAGE_SUBTITLE_PREFIX}${tab.nextSubtitleId}`,
      name: pageSubtitleName(tab.subtitleFiles, file.url, result.language),
      isDefault: false,
      url: file.url,
    };
    tab.nextSubtitleId += 1;
    if (result.language !== undefined) track.language = result.language;
    tab.subtitleFiles.push(track);
    for (const stream of tab.streams.values()) this.#applySubtitles(tab, stream);
    this.#markDirty(tab);
    if (result.cues && result.cues.length > 0) this.#checkCues(tab, track.id, file.frameId, result.cues, 0);
  }

  /**
   * Asks the player that loaded a page subtitle file (its frame, then the top
   * frame) which cues it shows, and records how far it moved the file's
   * times. Players add the cues some time after loading the file, so this is
   * tried a few times; once the cues are found (shifted or not) it stops.
   */
  #checkCues(tab: TabState, id: string, frameId: number, cues: readonly PageCue[], attempt: number): void {
    const read = this.#readTextTracks;
    const delay = this.#cueCheckDelaysMs[attempt];
    if (!read || delay === undefined) return;
    const generation = tab.subtitleGeneration;
    setTimeout(() => {
      void this.#track(
        (async () => {
          const current = () => tab.subtitleGeneration === generation && !tab.removed && tab.subtitleFiles.some((track) => track.id === id);
          if (!current()) return;
          let offsetSec: number | undefined;
          for (const frame of frameId === 0 ? [0] : [frameId, 0]) {
            const tracks = await read(tab.tabId, frame).catch(() => []);
            offsetSec = cueOffsetSec(cues, tracks);
            if (offsetSec !== undefined) break;
          }
          if (!current()) return;
          if (offsetSec === undefined) {
            this.#checkCues(tab, id, frameId, cues, attempt + 1);
            return;
          }
          const track = tab.subtitleFiles.find((candidate) => candidate.id === id);
          if (!track || offsetSec === 0 || track.offsetSec === offsetSec) return;
          track.offsetSec = offsetSec;
          this.#logger?.debug('A page subtitle file is shifted by its player', { id, offsetSec });
          for (const stream of tab.streams.values()) this.#applySubtitles(tab, stream);
          this.#markDirty(tab);
        })(),
      );
    }, delay);
  }

  #refresh(tab: TabState, stream: DetectedStream, candidate: DetectionCandidate): void {
    stream.lastSeen = Math.max(stream.lastSeen, candidate.timestamp);
    let changed = false;
    if (stream.url !== candidate.url) {
      stream.url = candidate.url;
      changed = true;
    }
    // A DOM report only guesses the Referer; it never replaces a context seen on the network.
    const guessed = candidate.match?.evidence === 'dom' && stream.evidence.some((evidence) => evidence !== 'dom');
    if (
      !guessed &&
      !isEmptyRequestContext(candidate.requestContext) &&
      requestContextKey(stream.requestContext) !== requestContextKey(candidate.requestContext)
    ) {
      stream.requestContext = candidate.requestContext;
      changed = true;
    }
    const evidence = candidate.match?.evidence;
    if (evidence !== undefined && !stream.evidence.includes(evidence)) {
      stream.evidence = [...stream.evidence, evidence];
      changed = true;
    }
    // The element's own title wins over frame-level titles, also when the element's request was seen first
    // (a media element loads its file before the content script's debounced DOM scan reports it).
    if (candidate.title !== undefined && stream.title !== candidate.title) {
      stream.title = candidate.title;
      changed = true;
    }
    if (candidate.subtitles && this.#setDomSubtitles(tab, stream, candidate.subtitles)) changed = true;
    if (!changed) return;
    this.#markDirty(tab);
    // A fresh URL or context (e.g. a re-signed link after expiry) is worth another inspection.
    const sinceLastTry = this.#now() - (stream.inspectedAt ?? 0);
    if (stream.status === 'error' && sinceLastTry >= this.#limits.retryFailedAfterMs) {
      stream.status = 'pending';
      delete stream.statusMessage;
      this.#scheduleInspection(tab, stream.id);
    }
  }

  async #probe(tab: TabState, candidate: DetectionCandidate, key: string, id: string): Promise<void> {
    const shape = urlShape(candidate.url);
    if (tab.probedShapes.has(shape) || tab.probes >= this.#limits.maxProbesPerPage) return;
    tab.probedShapes.add(shape);
    tab.probes += 1;
    const generation = tab.generation;
    const outcome = await this.#limit(() => this.#safeInspect(candidate.url, candidate.requestContext, 'manifest'));
    if (!this.#isCurrent(tab, generation) || outcome.kind !== 'manifest') return;
    // Only negative results are cached by shape; another manifest may share this one's shape.
    tab.probedShapes.delete(shape);
    if (outcome.info.live) {
      this.#forgetLive(tab, candidate.url, outcome.info);
      return;
    }
    if (tab.streams.has(id) || this.#isChildKey(tab, key) || tab.dismissedKeys.has(key)) return;
    const stream = this.#addStream(tab, candidate, key, id, outcome.info.protocol, 'content', false);
    this.#applyManifest(tab, stream, outcome.info);
  }

  #addStream(
    tab: TabState,
    candidate: DetectionCandidate,
    key: string,
    id: string,
    protocol: MediaProtocol,
    evidence: DetectionEvidence,
    inspect = true,
  ): DetectedStream {
    this.#evictIfFull(tab);
    const stream: DetectedStream = {
      id,
      tabId: tab.tabId,
      frameId: candidate.frameId,
      protocol,
      url: candidate.url,
      dedupeKey: key,
      evidence: [evidence],
      status: 'pending',
      requestContext: candidate.requestContext,
      firstSeen: candidate.timestamp,
      lastSeen: candidate.timestamp,
    };
    if (tab.pageUrl !== undefined) stream.pageUrl = tab.pageUrl;
    if (candidate.title !== undefined) stream.title = candidate.title;
    if (protocol === 'progressive' && candidate.progressive) stream.progressive = { ...candidate.progressive };
    if (candidate.subtitles) this.#setDomSubtitles(tab, stream, candidate.subtitles);
    tab.streams.set(id, stream);
    // A new video (on a single-page site, maybe the next one) may bring its own subtitle files.
    tab.subtitleChecks = 0;
    this.#markDirty(tab);
    if (inspect) this.#scheduleInspection(tab, id);
    this.#schedulePageInfo(tab, id);
    return stream;
  }

  #evictIfFull(tab: TabState): void {
    if (tab.streams.size < this.#limits.maxStreamsPerTab) return;
    let oldest: DetectedStream | undefined;
    for (const stream of tab.streams.values()) {
      if (!oldest || stream.lastSeen < oldest.lastSeen) oldest = stream;
    }
    if (oldest) tab.streams.delete(oldest.id);
  }

  #scheduleInspection(tab: TabState, id: string): void {
    const inspecting = tab.inspecting;
    if (inspecting.has(id)) return;
    inspecting.add(id);
    const generation = tab.generation;
    void this.#track(
      (async () => {
        try {
          // Looked up when its turn comes, and applied before the slot is freed: an entry dropped while
          // it waited (a live reload, a playlist folded under its master, a navigation) is not fetched.
          await this.#limit(async () => {
            const stream = tab.streams.get(id);
            if (!stream || !this.#isCurrent(tab, generation)) return;
            const kind: InspectionKind = stream.protocol === 'progressive' ? 'progressive' : 'manifest';
            const outcome = await this.#safeInspect(stream.url, stream.requestContext, kind);
            if (!this.#isCurrent(tab, generation)) return;
            const latest = tab.streams.get(id);
            if (latest) this.#applyOutcome(tab, latest, outcome);
          });
        } finally {
          inspecting.delete(id);
        }
      })(),
    );
  }

  async #safeInspect(url: string, context: RequestContext, kind: InspectionKind): Promise<InspectionOutcome> {
    try {
      return await this.#inspect(url, context, kind);
    } catch (error) {
      return { kind: 'failed', reason: errorMessage(error) };
    }
  }

  #applyOutcome(tab: TabState, stream: DetectedStream, outcome: InspectionOutcome): void {
    if ((outcome.kind === 'manifest' || outcome.kind === 'progressive') && isBlockedUrl(outcome.finalUrl)) {
      // Redirected onto a blocked site (a front end for YouTube): never listed, not inspected again.
      tab.streams.delete(stream.id);
      tab.dismissedKeys.add(stream.dedupeKey);
      this.#markDirty(tab);
      return;
    }
    switch (outcome.kind) {
      case 'manifest':
        this.#applyManifest(tab, stream, outcome.info);
        return;
      case 'progressive':
        this.#applyProgressive(tab, stream, outcome.info, outcome.finalUrl);
        return;
      case 'not-manifest':
        // The URL looked like a manifest but the body is not one (error page, plain M3U…),
        // or a media-element request was a segment of a stream rather than a whole file.
        if (stream.protocol === 'progressive') tab.segmentShapes.add(urlShape(stream.url));
        tab.streams.delete(stream.id);
        this.#logger?.debug('Dropped candidate that is not a manifest', { url: stream.url, reason: outcome.reason });
        this.#markDirty(tab);
        return;
      case 'failed':
        stream.status = 'error';
        stream.statusMessage = outcome.reason;
        stream.inspectedAt = this.#now();
        this.#markDirty(tab);
        return;
    }
  }

  #applyManifest(tab: TabState, stream: DetectedStream, info: ManifestInfo): void {
    if (info.live) {
      tab.streams.delete(stream.id);
      this.#forgetLive(tab, stream.url, info);
      return;
    }
    stream.protocol = info.protocol;
    stream.inspectedAt = this.#now();
    stream.manifest = {
      role: info.role,
      live: info.live,
      drmSystems: info.drmSystems,
      encryption: info.encryption,
    };
    if (info.media) stream.media = info.media;
    else delete stream.media;
    this.#applySubtitles(tab, stream);
    if (info.drmSystems.length > 0) {
      stream.status = 'drm';
      stream.statusMessage = describeDrm(info.drmSystems);
    } else {
      stream.status = 'ready';
      delete stream.statusMessage;
    }

    if (info.role === 'master') {
      const childKeys = [...new Set(info.childUrls.map(dedupeKey))].filter(
        (key) => key !== stream.dedupeKey,
      );
      stream.childKeys = childKeys;
      for (const other of [...tab.streams.values()]) {
        if (other.id !== stream.id && childKeys.includes(other.dedupeKey)) tab.streams.delete(other.id);
      }
    } else if (this.#isChildKey(tab, stream.dedupeKey)) {
      tab.streams.delete(stream.id);
    }
    this.#markDirty(tab);
  }

  /**
   * Live streams cannot be downloaded, so they are not listed at all: their
   * player reloads the playlist every few seconds, often with a new query, and
   * each reload would otherwise be a new entry and a new inspection (the list
   * and the badge grew to 99+ and evicted real videos). The manifest's path and
   * those of a live master's playlists are remembered until the next page;
   * entries of those paths still waiting for (or failing) an inspection go too.
   * Ready entries never do: they are videos that can be downloaded.
   */
  #forgetLive(tab: TabState, url: string, info: ManifestInfo): void {
    const keys = [url, ...info.childUrls].map(liveKey);
    for (const key of keys) tab.liveKeys.add(key);
    for (const other of [...tab.streams.values()]) {
      if ((other.status === 'pending' || other.status === 'error') && tab.liveKeys.has(liveKey(other.url))) tab.streams.delete(other.id);
    }
    this.#logger?.debug('Ignoring a live stream', { url });
    this.#markDirty(tab);
  }

  /**
   * A whole MP4/WebM file. It is listed with one "quality", the file itself,
   * so the Detected tab's selection works as for manifests. A link that
   * redirected (CDN, signed URL) is the same video as its target: the target
   * is folded under it like an HLS master's playlists, whichever was seen first.
   */
  #applyProgressive(tab: TabState, stream: DetectedStream, info: ProgressiveInfo, finalUrl: string): void {
    stream.inspectedAt = this.#now();
    stream.progressive = info;
    stream.media = { variants: [{ id: PROGRESSIVE_VARIANT_ID, audioOnly: false, audioTrackIds: [] }], audioTracks: [] };
    this.#applySubtitles(tab, stream);
    stream.status = 'ready';
    delete stream.statusMessage;
    const target = dedupeKey(finalUrl);
    if (target !== stream.dedupeKey) {
      stream.childKeys = [target];
      for (const other of [...tab.streams.values()]) {
        if (other.id !== stream.id && other.dedupeKey === target) tab.streams.delete(other.id);
      }
    }
    this.#markDirty(tab);
  }

  /** Records a progressive file's current `<track>` list (an empty one clears it); true when it changed. */
  #setDomSubtitles(tab: TabState, stream: DetectedStream, tracks: SubtitleTrackSummary[]): boolean {
    if (stream.protocol !== 'progressive') return false;
    if (JSON.stringify(stream.domSubtitles ?? []) === JSON.stringify(tracks)) return false;
    if (tracks.length > 0) stream.domSubtitles = tracks;
    else delete stream.domSubtitles;
    this.#applySubtitles(tab, stream);
    return true;
  }

  /**
   * Lists a stream's subtitles in its media summary, once it was inspected:
   * its own (manifest renditions; a progressive file's `<track>`s), then the
   * page's subtitle files (0.7.2) offered with every quality. A page file that
   * is also one of the video's `<track>`s is listed once, as the track.
   */
  #applySubtitles(tab: TabState, stream: DetectedStream): void {
    const media = stream.media;
    if (!media) return;
    const progressive = stream.protocol === 'progressive';
    const own = progressive ? (stream.domSubtitles ?? []) : (media.subtitleTracks ?? []).filter((track) => !isPageSubtitleId(track.id));
    const ownUrls = new Set(own.flatMap((track) => (track.url === undefined ? [] : [track.url])));
    // A manifest's own subtitle file is often fetched whole by the player too (DASH text, a one-file
    // HLS rendition): a page file in a language the manifest already has is that file again.
    const ownLanguages = new Set(progressive ? [] : own.flatMap((track) => languageKey(track.language) ?? []));
    const page = tab.subtitleFiles
      .filter((track) => track.url === undefined || !ownUrls.has(track.url))
      .filter((track) => { const language = languageKey(track.language); return language === undefined || !ownLanguages.has(language); })
      .map((track) => ({ ...track }));
    const tracks = [...own, ...page];
    if (tracks.length > 0) media.subtitleTracks = tracks;
    else delete media.subtitleTracks;
    const pageIds = page.map((track) => track.id);
    for (const variant of media.variants) {
      const ownIds = progressive ? own.map((track) => track.id) : (variant.subtitleTrackIds ?? []).filter((id) => !isPageSubtitleId(id));
      const ids = [...ownIds, ...pageIds];
      if (ids.length > 0) variant.subtitleTrackIds = ids;
      else delete variant.subtitleTrackIds;
    }
  }

  #schedulePageInfo(tab: TabState, id: string): void {
    const stream = tab.streams.get(id);
    if (!stream) return;
    const generation = tab.generation;
    void this.#track(
      this.#resolvePageInfo(tab.tabId, stream.frameId).then(
        (info) => {
          if (!this.#isCurrent(tab, generation)) return;
          const latest = tab.streams.get(id);
          if (!latest) return;
          if (latest.title === undefined && info.title !== undefined) latest.title = info.title;
          if (info.pageTitle !== undefined) latest.pageTitle = info.pageTitle;
          if (info.durationHint !== undefined) latest.durationHint = info.durationHint;
          if (isBlockedUrl(info.pageUrl)) {
            // Played inside a page of a blocked site (an embedded player's frame told us late): never listed.
            tab.pageUrl = info.pageUrl;
            tab.streams.delete(id);
            this.#markDirty(tab);
            return;
          }
          if (info.pageUrl !== undefined) {
            latest.pageUrl = info.pageUrl;
            tab.pageUrl ??= info.pageUrl;
          }
          this.#markDirty(tab);
        },
        (error: unknown) => {
          this.#logger?.debug('Page info lookup failed', { tabId: tab.tabId, error: errorMessage(error) });
        },
      ),
    );
  }

  // ------------------------------------------------------------ tab state

  #tab(tabId: number): Promise<TabState> {
    let state = this.#tabs.get(tabId);
    if (!state) {
      state = this.#loadTab(tabId);
      this.#tabs.set(tabId, state);
    }
    return state;
  }

  async #loadTab(tabId: number): Promise<TabState> {
    let stored: StoredTabDetections | null = null;
    try {
      stored = await this.#store.load(tabId);
    } catch (error) {
      this.#logger?.warn('Could not load tab detections', { tabId, error: errorMessage(error) });
    }
    const tab: TabState = {
      tabId,
      generation: stored?.generation ?? 0,
      pageUrl: stored?.pageUrl,
      streams: new Map((stored?.streams ?? []).map((stream) => [stream.id, stream])),
      probedShapes: new Set(),
      segmentShapes: new Set(),
      liveKeys: new Set(),
      probes: 0,
      inspecting: new Set(),
      dismissedKeys: new Set(),
      subtitleFiles: stored?.subtitleFiles ?? [],
      subtitleKeys: new Set((stored?.subtitleFiles ?? []).flatMap((track) => (track.url === undefined ? [] : [dedupeKey(track.url)]))),
      subtitleChecks: 0,
      subtitleRunShapes: new Set(),
      subtitleGeneration: 0,
      nextSubtitleId: Math.max(0, ...(stored?.subtitleFiles ?? []).map((track) => Number(track.id.slice(PAGE_SUBTITLE_PREFIX.length)) + 1).filter(Number.isFinite)),
      flushTimer: undefined,
      persisted: stored !== null,
      removed: false,
    };
    // Inspections interrupted by a service-worker restart.
    for (const stream of tab.streams.values()) {
      if (stream.status === 'pending') this.#scheduleInspection(tab, stream.id);
    }
    return tab;
  }

  #clear(tab: TabState): void {
    tab.generation += 1;
    tab.streams.clear();
    tab.probedShapes.clear();
    tab.segmentShapes.clear();
    tab.liveKeys.clear();
    tab.probes = 0;
    tab.inspecting = new Set();
  }

  /** A request of or from a blocked site (0.8.0): ignored before anything is fetched. The tab's page: `#onBlockedPage`. */
  #isBlocked(url: string, context: RequestContext): boolean {
    return involvesBlockedSite(url, context.referer, context.origin);
  }

  /** The tab shows a blocked site now (asked fresh, see `getTabUrl`); its URL is kept for later candidates. */
  async #onBlockedPage(tab: TabState): Promise<boolean> {
    if (!this.#getTabUrl) return isBlockedUrl(tab.pageUrl);
    let url: string | undefined;
    try {
      url = await this.#getTabUrl(tab.tabId);
    } catch {
      return isBlockedUrl(tab.pageUrl);
    }
    if (url === undefined || parseHttpUrl(url) === null) return isBlockedUrl(tab.pageUrl);
    tab.pageUrl = url;
    return isBlockedUrl(url);
  }

  #isCurrent(tab: TabState, generation: number): boolean {
    return !tab.removed && tab.generation === generation;
  }

  #isChildKey(tab: TabState, key: string): boolean {
    for (const stream of tab.streams.values()) {
      if (stream.childKeys?.includes(key)) return true;
    }
    return false;
  }

  #visible(tab: TabState): DetectedStream[] {
    return [...tab.streams.values()].sort((a, b) => a.firstSeen - b.firstSeen);
  }

  // ----------------------------------------------------------- persistence

  #markDirty(tab: TabState): void {
    if (tab.removed || tab.flushTimer !== undefined) return;
    tab.flushTimer = setTimeout(() => {
      tab.flushTimer = undefined;
      void this.#track(this.#persist(tab));
    }, this.#flushDelayMs);
  }

  #flushNow(tab: TabState): Promise<void> {
    clearTimeout(tab.flushTimer);
    tab.flushTimer = undefined;
    return this.#persist(tab);
  }

  /** Writes are chained per tab so they land in order. Empty tabs are removed from storage. */
  #persist(tab: TabState): Promise<void> {
    const previous = this.#saveChains.get(tab.tabId) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (tab.removed) return;
      const streams = this.#visible(tab);
      try {
        if (streams.length === 0 && tab.subtitleFiles.length === 0) {
          if (tab.persisted) await this.#store.remove(tab.tabId);
          tab.persisted = false;
        } else {
          const record: StoredTabDetections = {
            version: 1,
            tabId: tab.tabId,
            generation: tab.generation,
            streams,
            updatedAt: this.#now(),
          };
          if (tab.pageUrl !== undefined) record.pageUrl = tab.pageUrl;
          // Kept also before any video is found: a player often loads its subtitles first.
          if (tab.subtitleFiles.length > 0) record.subtitleFiles = tab.subtitleFiles;
          await this.#store.save(record);
          tab.persisted = true;
        }
        this.#onTabChanged?.(tab.tabId, streams);
      } catch (error) {
        this.#logger?.error('Could not save tab detections', { tabId: tab.tabId, error: errorMessage(error) });
      }
    });
    this.#saveChains.set(tab.tabId, next);
    return next;
  }

  #track<T>(promise: Promise<T>): Promise<T> {
    this.#pending.add(promise);
    void promise.finally(() => this.#pending.delete(promise)).catch(() => undefined);
    return promise;
  }
}
