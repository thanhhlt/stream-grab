import {
  isEmptyRequestContext,
  requestContextKey,
  type DetectedStream,
  type DetectionEvidence,
  type RequestContext,
  type StreamingProtocol,
} from '@/core/models/detected-stream';
import { describeDrm } from '@/core/protocols/drm';
import { createLimiter, type Limiter } from '@/shared/utils/concurrency';
import { errorMessage } from '@/shared/utils/errors';
import { stableHash } from '@/shared/utils/hash';
import type { Logger } from '@/shared/utils/logger';
import { dedupeKey, parseHttpUrl, urlShape } from '@/shared/utils/url';
import type { DetectionStore, StoredTabDetections } from './detection-store';
import type { ManifestInfo } from './manifest-inspector';
import type { InspectionOutcome } from './stream-inspector';

/** A possible manifest observed in a tab (network request or DOM element). */
export interface DetectionCandidate {
  tabId: number;
  frameId: number;
  url: string;
  /** Known protocol and the evidence for it; absent when the body must be sniffed before listing. */
  match?: { protocol: StreamingProtocol; evidence: DetectionEvidence };
  requestContext: RequestContext;
  timestamp: number;
  /** Title known exactly for this URL (its own <video> element); wins over frame-level titles. */
  title?: string;
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
}

export const DEFAULT_DETECTION_LIMITS: Readonly<DetectionLimits> = {
  maxStreamsPerTab: 100,
  maxProbesPerPage: 40,
  retryFailedAfterMs: 5_000,
};

export interface DetectionManagerOptions {
  store: DetectionStore;
  inspect: (url: string, context: RequestContext) => Promise<InspectionOutcome>;
  resolvePageInfo: (tabId: number, frameId: number) => Promise<PageInfo>;
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
  probes: number;
  inspecting: Set<string>;
  /** Dedupe keys the user removed; ignored until the next navigation. */
  dismissedKeys: Set<string>;
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Whether a record for this tab exists in the store. */
  persisted: boolean;
  removed: boolean;
}

export function streamIdFor(key: string): string {
  return `s${stableHash(key)}`;
}

/**
 * Owns the per-tab list of detected streams.
 *
 * - Deduplicates by `dedupeKey` (URL without tokens/cache busters) and keeps
 *   the freshest URL and request context of each manifest.
 * - Inspects every new manifest once (bounded concurrency) to confirm the
 *   protocol and fold HLS variant/rendition playlists under their master, so
 *   one video is listed once even though the player loads several playlists.
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

  /** The tab navigated to a new document: forget everything detected for the previous one. */
  resetTab(tabId: number, pageUrl?: string): Promise<void> {
    return this.#track(
      (async () => {
        const tab = await this.#tab(tabId);
        this.#clear(tab);
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
    if (tab.removed) return;
    const key = dedupeKey(candidate.url);
    if (tab.dismissedKeys.has(key) || this.#isChildKey(tab, key)) return;
    const id = streamIdFor(key);
    const existing = tab.streams.get(id);
    if (existing) {
      this.#refresh(tab, existing, candidate);
      return;
    }
    if (!candidate.match) {
      await this.#probe(tab, candidate, key, id);
      return;
    }
    this.#addStream(tab, candidate, key, id, candidate.match.protocol, candidate.match.evidence);
  }

  #refresh(tab: TabState, stream: DetectedStream, candidate: DetectionCandidate): void {
    stream.lastSeen = Math.max(stream.lastSeen, candidate.timestamp);
    let changed = false;
    if (stream.url !== candidate.url) {
      stream.url = candidate.url;
      changed = true;
    }
    if (
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
    const outcome = await this.#limit(() => this.#safeInspect(candidate.url, candidate.requestContext));
    if (!this.#isCurrent(tab, generation) || outcome.kind !== 'manifest') return;
    // Only negative results are cached by shape; another manifest may share this one's shape.
    tab.probedShapes.delete(shape);
    if (tab.streams.has(id) || this.#isChildKey(tab, key) || tab.dismissedKeys.has(key)) return;
    const stream = this.#addStream(tab, candidate, key, id, outcome.info.protocol, 'content', false);
    this.#applyManifest(tab, stream, outcome.info);
  }

  #addStream(
    tab: TabState,
    candidate: DetectionCandidate,
    key: string,
    id: string,
    protocol: StreamingProtocol,
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
    tab.streams.set(id, stream);
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
          const stream = tab.streams.get(id);
          if (!stream) return;
          const outcome = await this.#limit(() => this.#safeInspect(stream.url, stream.requestContext));
          if (!this.#isCurrent(tab, generation)) return;
          const latest = tab.streams.get(id);
          if (latest) this.#applyOutcome(tab, latest, outcome);
        } finally {
          inspecting.delete(id);
        }
      })(),
    );
  }

  async #safeInspect(url: string, context: RequestContext): Promise<InspectionOutcome> {
    try {
      return await this.#inspect(url, context);
    } catch (error) {
      return { kind: 'failed', reason: errorMessage(error) };
    }
  }

  #applyOutcome(tab: TabState, stream: DetectedStream, outcome: InspectionOutcome): void {
    switch (outcome.kind) {
      case 'manifest':
        this.#applyManifest(tab, stream, outcome.info);
        return;
      case 'not-manifest':
        // The URL looked like a manifest but the body is not one (error page, plain M3U…).
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
      probes: 0,
      inspecting: new Set(),
      dismissedKeys: new Set(),
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
    tab.probes = 0;
    tab.inspecting = new Set();
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
        if (streams.length === 0) {
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
