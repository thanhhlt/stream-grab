import type { PageInfo } from '@/core/detection/detection-manager';
import { buildPageInfo } from '@/core/detection/stream-title';
import { parseFrameMetadata, type FrameMetadata } from '@/shared/types/page-metadata';

export interface PageInfoDeps {
  getTab(tabId: number): Promise<{ url?: string | undefined; title?: string | undefined } | null>;
  /** Raw (unvalidated) metadata from the content script in that frame; rejects when it is not reachable. */
  getFrameMetadata(tabId: number, frameId: number): Promise<unknown>;
  delay(ms: number): Promise<void>;
  /**
   * The manifest request can arrive before the frame's content script is
   * injected (document_idle), so the lookup is retried after these delays.
   */
  retryDelaysMs?: readonly number[];
  /** Lookups for the same frame within this window share one round trip. */
  cacheMs?: number;
  now?: () => number;
}

export type PageInfoResolver = (tabId: number, frameId: number) => Promise<PageInfo>;

export function createPageInfoResolver(deps: PageInfoDeps): PageInfoResolver {
  const retryDelays = deps.retryDelaysMs ?? [0, 1500, 5000];
  const cacheMs = deps.cacheMs ?? 3000;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; metadata: Promise<FrameMetadata | null> }>();

  const lookupOnce = async (tabId: number, frameId: number): Promise<FrameMetadata | null> => {
    try {
      return parseFrameMetadata(await deps.getFrameMetadata(tabId, frameId));
    } catch {
      return null;
    }
  };

  const lookup = (tabId: number, frameId: number): Promise<FrameMetadata | null> => {
    const key = `${tabId}:${frameId}`;
    const cached = cache.get(key);
    if (cached && now() - cached.at < cacheMs) return cached.metadata;
    const metadata = (async () => {
      for (const wait of retryDelays) {
        if (wait > 0) await deps.delay(wait);
        const result = await lookupOnce(tabId, frameId);
        if (result) return result;
      }
      return null;
    })();
    cache.set(key, { at: now(), metadata });
    for (const [entryKey, entry] of cache) {
      if (now() - entry.at >= cacheMs) cache.delete(entryKey);
    }
    return metadata;
  };

  return async (tabId, frameId) => {
    const [tab, frame] = await Promise.all([deps.getTab(tabId).catch(() => null), lookup(tabId, frameId)]);
    const top = frameId === 0 ? frame : await lookup(tabId, 0);
    return buildPageInfo({ frame, top, tab });
  };
}
