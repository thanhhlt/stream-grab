import { DetectionManager } from '@/core/detection/detection-manager';
import { SessionDetectionStore } from '@/core/detection/detection-store';
import { domSourceCandidate } from '@/core/detection/dom-candidate';
import { inspectStream } from '@/core/detection/stream-inspector';
import { ManifestFetcher } from '@/core/network/manifest-fetcher';
import { DashAdapter } from '@/core/protocols/dash/dash-adapter';
import { HlsAdapter } from '@/core/protocols/hls/hls-adapter';
import { ProtocolRegistry } from '@/core/protocols/protocol-adapter';
import { sendToContent } from '@/shared/messaging/client';
import { getSettingsStore } from '@/shared/settings/settings-store';
import type { DomSource } from '@/shared/types/page-metadata';
import { errorMessage } from '@/shared/utils/errors';
import { createLogger } from '@/shared/utils/logger';
import { initBadgeStyle, updateBadge } from './badge';
import { NetworkMonitor } from './network-monitor';
import { createPageInfoResolver } from './page-info';
import { RequestContextRules } from './request-context';

export interface DetectionService {
  manager: DetectionManager;
  /** Protocol adapters (HLS, DASH), shared with task validation. */
  protocols: ProtocolRegistry;
  /** Header rules for the extension's own requests, shared with the download engine's leases. */
  rules: RequestContextRules;
  /** Manifest URLs a content script found in <video>/<source> elements. */
  handleDomSources(tabId: number, frameId: number, frameUrl: string | undefined, sources: readonly DomSource[]): void;
}

const log = createLogger('detection');

/**
 * Composition root of stream detection in the service worker. Must be called
 * synchronously at startup: it registers the webRequest and tabs listeners
 * that Chrome uses to wake a suspended worker.
 */
export function startDetectionService(): DetectionService {
  const rules = new RequestContextRules(chrome.declarativeNetRequest, chrome.runtime.id);
  rules.initialize().catch((error: unknown) => {
    log.warn('Could not reset request-context rules', { error: errorMessage(error) });
  });
  const fetcher = new ManifestFetcher({
    fetch: (input, init) => fetch(input, init),
    acquireContext: (url, context) => rules.acquire(url, context),
  });
  const protocols = new ProtocolRegistry().register(new HlsAdapter({ fetcher })).register(new DashAdapter({ fetcher }));

  const manager = new DetectionManager({
    store: new SessionDetectionStore(chrome.storage.session),
    inspect: (url, context) => inspectStream({ fetcher, protocols }, url, context),
    resolvePageInfo: createPageInfoResolver({
      getTab: async (tabId) => {
        const tab = await chrome.tabs.get(tabId);
        return { url: tab.url, title: tab.title };
      },
      getFrameMetadata: (tabId, frameId) => sendToContent(tabId, frameId, 'content/getMetadata'),
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }),
    onTabChanged: (tabId, streams) => {
      updateBadge(tabId, streams.length);
    },
    logger: log,
  });

  // Detection is on until settings say otherwise; candidates wait for the settings read.
  let enabled = true;
  const store = getSettingsStore();
  const settingsLoaded = store.load().then(
    (settings) => {
      applyEnabled(settings.autoDetect);
    },
    (error: unknown) => {
      log.warn('Could not read settings; detection stays on', { error: errorMessage(error) });
    },
  );
  const whenEnabled = (action: () => Promise<unknown>): void => {
    void settingsLoaded.then(() => (enabled ? action() : undefined));
  };

  const monitor = new NetworkMonitor(
    chrome.webRequest,
    {
      candidate: (candidate) => {
        whenEnabled(() => manager.handleCandidate(candidate));
      },
      navigation: (tabId, url) => {
        void manager.resetTab(tabId, url);
      },
    },
    chrome.runtime.id,
  );
  monitor.registerNavigationListener();
  monitor.setEnabled(true);

  function applyEnabled(autoDetect: boolean): void {
    enabled = autoDetect;
    monitor.setEnabled(autoDetect);
  }
  store.subscribe((settings) => {
    applyEnabled(settings.autoDetect);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void manager.dropTab(tabId);
  });
  chrome.tabs.onReplaced.addListener((_addedTabId, removedTabId) => {
    void manager.dropTab(removedTabId);
  });
  initBadgeStyle();

  return {
    manager,
    protocols,
    rules,
    handleDomSources(tabId, frameId, frameUrl, sources) {
      for (const source of sources) {
        const candidate = domSourceCandidate(tabId, frameId, frameUrl, source, Date.now());
        whenEnabled(() => manager.handleCandidate(candidate));
      }
    },
  };
}
