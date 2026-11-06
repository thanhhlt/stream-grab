import type { DetectionCandidate } from '@/core/detection/detection-manager';
import { classifyResponse, OBSERVED_RESOURCE_TYPES } from '@/core/detection/manifest-detector';
import { isEmptyRequestContext, type RequestContext } from '@/core/models/detected-stream';
import { pickRequestContext, type HeaderLike } from './request-context';

/**
 * Observes the network with chrome.webRequest (non-blocking, as MV3 allows):
 *  - onSendHeaders captures the Referer/Origin of candidate requests,
 *  - onResponseStarted classifies responses (status, Content-Type, URL),
 *  - onResponseStarted for main frames signals navigations.
 *
 * Requests that are not tied to a tab (tabId -1) are skipped: that includes
 * the extension's own manifest fetches, so they can never be detected as new
 * streams. Prerendering and unloading documents are skipped too.
 */

type Listener<T> = (details: T) => void;

/** The subset of a chrome.webRequest event used here (injectable for tests). */
export interface WebRequestEventLike<T> {
  addListener(callback: Listener<T>, filter: chrome.webRequest.RequestFilter, extraInfoSpec?: string[]): void;
  removeListener(callback: Listener<T>): void;
}

export interface WebRequestApi {
  onSendHeaders: WebRequestEventLike<chrome.webRequest.OnSendHeadersDetails>;
  onResponseStarted: WebRequestEventLike<chrome.webRequest.OnResponseStartedDetails>;
  onErrorOccurred: WebRequestEventLike<chrome.webRequest.OnErrorOccurredDetails>;
}

export interface NetworkMonitorSink {
  candidate(candidate: DetectionCandidate): void;
  /** A tab's top frame started loading a new document. */
  navigation(tabId: number, url: string): void;
}

const HTTP_URLS = ['http://*/*', 'https://*/*'];
export const MEDIA_REQUEST_FILTER: chrome.webRequest.RequestFilter = {
  urls: HTTP_URLS,
  types: [...OBSERVED_RESOURCE_TYPES],
};
export const NAVIGATION_FILTER: chrome.webRequest.RequestFilter = { urls: HTTP_URLS, types: ['main_frame'] };

/** In-flight requests whose context is remembered until their response starts. */
const MAX_PENDING_CONTEXTS = 2000;

function headerValue(headers: readonly HeaderLike[] | undefined, name: string): string | undefined {
  return headers?.find((header) => header.name.toLowerCase() === name)?.value;
}

function contentLength(headers: readonly HeaderLike[] | undefined): number | undefined {
  const value = headerValue(headers, 'content-length');
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
  return Number(value);
}

export class NetworkMonitor {
  readonly #api: WebRequestApi;
  readonly #sink: NetworkMonitorSink;
  readonly #extensionOrigin: string;
  readonly #contexts = new Map<string, RequestContext>();
  #enabled = false;
  #navigationRegistered = false;

  constructor(api: WebRequestApi, sink: NetworkMonitorSink, extensionId: string) {
    this.#api = api;
    this.#sink = sink;
    this.#extensionOrigin = `chrome-extension://${extensionId}`;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** Navigation tracking stays on even when detection is disabled, so stale lists are still cleared. */
  registerNavigationListener(): void {
    if (this.#navigationRegistered) return;
    this.#navigationRegistered = true;
    this.#api.onResponseStarted.addListener(this.#onNavigation, NAVIGATION_FILTER);
  }

  /**
   * Adds or removes the media listeners. Removing them (detection disabled)
   * also stops Chrome from waking the service worker for every XHR.
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    if (enabled) {
      this.#api.onSendHeaders.addListener(this.#onSendHeaders, MEDIA_REQUEST_FILTER, ['requestHeaders', 'extraHeaders']);
      this.#api.onResponseStarted.addListener(this.#onResponseStarted, MEDIA_REQUEST_FILTER, ['responseHeaders']);
      this.#api.onErrorOccurred.addListener(this.#onErrorOccurred, MEDIA_REQUEST_FILTER);
    } else {
      this.#api.onSendHeaders.removeListener(this.#onSendHeaders);
      this.#api.onResponseStarted.removeListener(this.#onResponseStarted);
      this.#api.onErrorOccurred.removeListener(this.#onErrorOccurred);
      this.#contexts.clear();
    }
  }

  #isObservable(details: chrome.webRequest.WebRequestDetails): boolean {
    return (
      details.tabId >= 0 &&
      details.method === 'GET' &&
      details.initiator !== this.#extensionOrigin &&
      details.documentLifecycle !== 'prerender' &&
      details.documentLifecycle !== 'pending_deletion'
    );
  }

  readonly #onSendHeaders = (details: chrome.webRequest.OnSendHeadersDetails): void => {
    if (!this.#isObservable(details)) return;
    const context = pickRequestContext(details.requestHeaders);
    if (isEmptyRequestContext(context)) return;
    if (this.#contexts.size >= MAX_PENDING_CONTEXTS) {
      const oldest = this.#contexts.keys().next();
      if (!oldest.done) this.#contexts.delete(oldest.value);
    }
    // Redirect hops reuse the request ID; the last hop's headers win.
    this.#contexts.set(details.requestId, context);
  };

  readonly #onResponseStarted = (details: chrome.webRequest.OnResponseStartedDetails): void => {
    const context = this.#contexts.get(details.requestId) ?? {};
    this.#contexts.delete(details.requestId);
    if (!this.#isObservable(details)) return;

    const verdict = classifyResponse({
      url: details.url,
      method: details.method,
      resourceType: details.type,
      statusCode: details.statusCode,
      contentType: headerValue(details.responseHeaders, 'content-type'),
      contentLength: contentLength(details.responseHeaders),
    });
    if (verdict.kind === 'ignore') return;

    const candidate: DetectionCandidate = {
      tabId: details.tabId,
      // Requests from workers report frameId -1; attribute them to the top frame.
      frameId: Math.max(0, details.frameId),
      url: details.url,
      requestContext: context,
      timestamp: details.timeStamp,
    };
    if (verdict.kind === 'manifest') candidate.match = { protocol: verdict.protocol, evidence: verdict.evidence };
    this.#sink.candidate(candidate);
  };

  readonly #onErrorOccurred = (details: chrome.webRequest.OnErrorOccurredDetails): void => {
    this.#contexts.delete(details.requestId);
  };

  readonly #onNavigation = (details: chrome.webRequest.OnResponseStartedDetails): void => {
    if (details.tabId < 0 || details.frameId !== 0 || details.documentLifecycle === 'prerender') return;
    if (details.statusCode < 200 || details.statusCode >= 300 || details.statusCode === 204) return;
    this.#sink.navigation(details.tabId, details.url);
  };
}
