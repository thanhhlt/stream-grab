import { beforeEach, describe, expect, it } from 'vitest';
import {
  MEDIA_REQUEST_FILTER,
  NAVIGATION_FILTER,
  NetworkMonitor,
  type WebRequestApi,
  type WebRequestEventLike,
} from '@/background/network-monitor';
import type { DetectionCandidate } from '@/core/detection/detection-manager';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

class FakeEvent<T> implements WebRequestEventLike<T> {
  readonly listeners: { callback: (details: T) => void; filter: chrome.webRequest.RequestFilter; extra?: string[] }[] = [];

  addListener(callback: (details: T) => void, filter: chrome.webRequest.RequestFilter, extra?: string[]): void {
    this.listeners.push(extra === undefined ? { callback, filter } : { callback, filter, extra });
  }

  removeListener(callback: (details: T) => void): void {
    const index = this.listeners.findIndex((listener) => listener.callback === callback);
    if (index >= 0) this.listeners.splice(index, 1);
  }

  /** Delivers like Chrome: only to listeners whose type filter matches. */
  emit(details: T & { type: string }): void {
    for (const listener of [...this.listeners]) {
      if (!listener.filter.types || listener.filter.types.includes(details.type as never)) listener.callback(details);
    }
  }
}

function base(overrides: Partial<chrome.webRequest.WebRequestDetails> = {}): chrome.webRequest.WebRequestDetails {
  return {
    requestId: '1',
    url: 'https://cdn.example.com/hls/master.m3u8?token=abc',
    method: 'GET',
    type: 'xmlhttprequest',
    tabId: 7,
    frameId: 0,
    parentFrameId: -1,
    frameType: 'outermost_frame',
    documentLifecycle: 'active',
    initiator: 'https://site.example',
    timeStamp: 5_000,
    ...overrides,
  };
}

function response(
  overrides: Partial<chrome.webRequest.OnResponseStartedDetails> = {},
  contentType = 'application/vnd.apple.mpegurl',
): chrome.webRequest.OnResponseStartedDetails {
  return {
    ...base(overrides),
    statusCode: 200,
    statusLine: 'HTTP/1.1 200 OK',
    fromCache: false,
    responseHeaders: [{ name: 'Content-Type', value: contentType }],
    ...overrides,
  };
}

describe('NetworkMonitor', () => {
  let api: {
    onSendHeaders: FakeEvent<chrome.webRequest.OnSendHeadersDetails>;
    onResponseStarted: FakeEvent<chrome.webRequest.OnResponseStartedDetails>;
    onErrorOccurred: FakeEvent<chrome.webRequest.OnErrorOccurredDetails>;
  };
  let candidates: DetectionCandidate[];
  let navigations: [number, string][];
  let monitor: NetworkMonitor;

  beforeEach(() => {
    api = { onSendHeaders: new FakeEvent(), onResponseStarted: new FakeEvent(), onErrorOccurred: new FakeEvent() };
    candidates = [];
    navigations = [];
    monitor = new NetworkMonitor(
      api satisfies WebRequestApi,
      {
        candidate: (candidate) => candidates.push(candidate),
        navigation: (tabId, url) => navigations.push([tabId, url]),
      },
      EXTENSION_ID,
    );
    monitor.registerNavigationListener();
    monitor.setEnabled(true);
  });

  it('registers non-blocking listeners with the headers it needs', () => {
    expect(api.onSendHeaders.listeners[0]).toMatchObject({
      filter: MEDIA_REQUEST_FILTER,
      extra: ['requestHeaders', 'extraHeaders'],
    });
    expect(api.onResponseStarted.listeners.map((listener) => listener.filter)).toEqual([NAVIGATION_FILTER, MEDIA_REQUEST_FILTER]);
  });

  it('reports manifests with the tab, frame and captured Referer/Origin', () => {
    api.onSendHeaders.emit({
      ...base({ frameId: 3 }),
      requestHeaders: [
        { name: 'Referer', value: 'https://site.example/watch' },
        { name: 'Cookie', value: 'secret=1' },
      ],
    });
    api.onResponseStarted.emit(response({ frameId: 3 }));
    expect(candidates).toEqual([
      {
        tabId: 7,
        frameId: 3,
        url: 'https://cdn.example.com/hls/master.m3u8?token=abc',
        match: { protocol: 'hls', evidence: 'content-type' },
        requestContext: { referer: 'https://site.example/watch' },
        timestamp: 5_000,
      },
    ]);
  });

  it('reports progressive MP4/WebM files played by media elements with their Referer/Origin (0.3.0)', () => {
    const url = 'https://media.example.net/v/clip.mp4?Expires=99&Signature=s';
    api.onSendHeaders.emit({
      ...base({ requestId: '9', url, type: 'media' }),
      requestHeaders: [
        { name: 'Referer', value: 'https://site.example/watch/1' },
        { name: 'Origin', value: 'https://site.example' },
        { name: 'Range', value: 'bytes=0-' },
      ],
    });
    api.onResponseStarted.emit({
      ...response({ requestId: '9', url, type: 'media', statusCode: 206 }, 'video/mp4'),
      responseHeaders: [
        { name: 'Content-Type', value: 'video/mp4' },
        { name: 'Content-Length', value: String(3 * 1024 ** 3) },
      ],
    });
    // The same file requested by script (Media Source Extensions) is a segment, as before.
    api.onResponseStarted.emit(response({ requestId: '10', url, type: 'xmlhttprequest' }, 'video/mp4'));
    expect(candidates).toEqual([
      {
        tabId: 7,
        frameId: 0,
        url,
        match: { protocol: 'progressive', evidence: 'content-type' },
        progressive: { container: 'mp4', mimeType: 'video/mp4' },
        requestContext: { referer: 'https://site.example/watch/1', origin: 'https://site.example' },
        timestamp: 5_000,
      },
    ]);
  });

  it('forwards probe candidates without a protocol match', () => {
    api.onResponseStarted.emit(response({ url: 'https://api.example.com/v/1/playlist' }, 'text/plain'));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.match).toBeUndefined();
  });

  it('ignores segments, failures and requests not tied to a tab or made by the extension', () => {
    api.onResponseStarted.emit(response({ url: 'https://cdn.example.com/hls/seg1.ts' }, 'video/mp2t'));
    api.onResponseStarted.emit(response({ statusCode: 403 }));
    api.onResponseStarted.emit(response({ tabId: -1 }));
    api.onResponseStarted.emit(response({ initiator: `chrome-extension://${EXTENSION_ID}` }));
    api.onResponseStarted.emit(response({ documentLifecycle: 'prerender' }));
    api.onResponseStarted.emit(response({ method: 'POST' }));
    expect(candidates).toEqual([]);
  });

  it('attributes worker requests (frameId -1) to the top frame', () => {
    api.onResponseStarted.emit(response({ frameId: -1 }));
    expect(candidates[0]?.frameId).toBe(0);
  });

  it('forgets captured headers of failed requests', () => {
    api.onSendHeaders.emit({ ...base(), requestHeaders: [{ name: 'Referer', value: 'https://site.example/' }] });
    api.onErrorOccurred.emit({ ...base(), error: 'net::ERR_ABORTED', fromCache: false });
    api.onResponseStarted.emit(response());
    expect(candidates[0]?.requestContext).toEqual({});
  });

  it('reports top-frame navigations, not subframes, prerenders or failed loads', () => {
    const nav = (overrides: Partial<chrome.webRequest.OnResponseStartedDetails>) =>
      response({ type: 'main_frame', url: 'https://site.example/next', ...overrides }, 'text/html');
    api.onResponseStarted.emit(nav({}));
    api.onResponseStarted.emit(nav({ type: 'sub_frame', frameId: 4 }));
    api.onResponseStarted.emit(nav({ documentLifecycle: 'prerender' }));
    api.onResponseStarted.emit(nav({ statusCode: 204 }));
    api.onResponseStarted.emit(nav({ tabId: -1 }));
    expect(navigations).toEqual([[7, 'https://site.example/next']]);
    expect(candidates).toEqual([]);
  });

  it('removes its media listeners when disabled but keeps tracking navigations', () => {
    monitor.setEnabled(false);
    expect(api.onSendHeaders.listeners).toHaveLength(0);
    expect(api.onErrorOccurred.listeners).toHaveLength(0);
    expect(api.onResponseStarted.listeners.map((listener) => listener.filter)).toEqual([NAVIGATION_FILTER]);
    api.onResponseStarted.emit(response());
    expect(candidates).toEqual([]);
    monitor.setEnabled(true);
    monitor.setEnabled(true);
    expect(api.onResponseStarted.listeners).toHaveLength(2);
  });
});
