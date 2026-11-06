import { beforeAll, describe, expect, it } from 'vitest';
import { createPageInfoResolver } from '@/background/page-info';
import { RequestContextRules } from '@/background/request-context';
import { DetectionManager, type DetectionCandidate } from '@/core/detection/detection-manager';
import { SessionDetectionStore } from '@/core/detection/detection-store';
import { domSourceCandidate } from '@/core/detection/dom-candidate';
import { inspectProgressiveFile } from '@/core/detection/file-inspector';
import { classifyResponse } from '@/core/detection/manifest-detector';
import { inspectStream } from '@/core/detection/stream-inspector';
import type { DetectedStream, RequestContext } from '@/core/models/detected-stream';
import { ManifestFetcher, type AcquireRequestContext, type FetchFunction } from '@/core/network/manifest-fetcher';
import { DashAdapter } from '@/core/protocols/dash/dash-adapter';
import { HlsAdapter } from '@/core/protocols/hls/hls-adapter';
import { ProtocolRegistry } from '@/core/protocols/protocol-adapter';
import { FakeStorageArea } from '@tests/fakes/fake-storage';
import { createFixtureRouter, type FixtureResponse } from '@tests/fixtures/fixture-routes';
import hlsMaster from '@tests/fixtures/manifests/hls/master.m3u8?raw';
import hlsTs from '@tests/fixtures/manifests/hls/media-ts.m3u8?raw';
import { syntheticFiles, type SyntheticFiles } from '@tests/fixtures/media/synthetic-files';
import {
  createProgressiveRouter,
  MSE_SEGMENT_PATH,
  PROGRESSIVE_FILES,
  PROGRESSIVE_PAGE_PATH,
  REDIRECT_TARGET_PATH,
} from '@tests/fixtures/progressive-routes';

/**
 * Progressive MP4/WebM detection end to end without Chrome (0.3.0, Phase 2):
 * the fixture site's /files page (real files, byte ranges, a redirect, a
 * Referer check, an MSE-style fetch) goes through the real response
 * classifier, file inspector and detection manager, next to an HLS stream.
 * The browser parts are simulated: webRequest events, the content script's
 * DOM report, and the DNR rule that replays the page's Referer on the
 * extension's own requests (here: `acquireContext` sets it for the host).
 * The same page runs in real Chrome in tests/e2e/extension.e2e.ts.
 */

const ORIGIN = 'http://localhost:5180';
const PAGE = `${ORIGIN}${PROGRESSIVE_PAGE_PATH}`;
const MASTER_PATH = '/vod/movie/master.m3u8?token=abc';

let files: SyntheticFiles;
let route: (pathname: string, request?: { referer?: string; range?: string }) => FixtureResponse;

beforeAll(async () => {
  files = await syntheticFiles();
  route = createFixtureRouter(
    {
      manifest: (path) => {
        if (path === 'hls/master.m3u8') return hlsMaster;
        if (path === 'hls/media-ts.m3u8') return hlsTs;
        throw new Error(`missing fixture ${path}`);
      },
      page: () => '<!doctype html>',
    },
    undefined,
    createProgressiveRouter(files),
  );
}, 60_000);

/** The page's own request as the server answers it, after redirects (what webRequest reports). */
function pageRequest(path: string, range?: string): { url: string; response: FixtureResponse } {
  let url = new URL(path, ORIGIN);
  for (let hops = 0; ; hops++) {
    const response = route(url.pathname, { referer: PAGE, ...(range ? { range } : {}) });
    const location = response.headers?.['location'];
    if (response.status !== 302 || location === undefined || hops > 5) return { url: url.href, response };
    url = new URL(location, url);
  }
}

/**
 * The extension's network: no page Referer of its own; the real
 * RequestContextRules installs DNR session rules, and requests to a host
 * with a rule carry the Referer it sets (what Chrome does with the rule).
 */
function extensionNetwork() {
  let installed: chrome.declarativeNetRequest.Rule[] = [];
  const dnr = {
    getSessionRules: () => Promise.resolve(installed),
    updateSessionRules: (options: chrome.declarativeNetRequest.UpdateRuleOptions) => {
      installed = [...installed.filter((rule) => !(options.removeRuleIds ?? []).includes(rule.id)), ...(options.addRules ?? [])];
      return Promise.resolve();
    },
  };
  const rules = new RequestContextRules(dnr, 'extension-id');
  const acquireContext: AcquireRequestContext = (url, context: RequestContext) => rules.acquire(url, context);
  const refererFor = (url: URL): string | undefined =>
    installed
      .find((rule) => rule.condition.requestDomains?.includes(url.hostname))
      ?.action.requestHeaders?.find((header) => header.header === 'referer')?.value;
  const requests: { path: string; referer: string | undefined; range: string | null }[] = [];
  const fetch: FetchFunction = (input, init) => {
    let url = new URL(input);
    const range = new Headers(init.headers).get('range');
    for (let hops = 0; ; hops++) {
      const referer = refererFor(url);
      requests.push({ path: url.pathname, referer, range });
      const answer = route(url.pathname, { ...(referer ? { referer } : {}), ...(range ? { range } : {}) });
      const location = answer.headers?.['location'];
      if (answer.status === 302 && location !== undefined && hops < 5) {
        url = new URL(location, url);
        continue;
      }
      const response = new Response(answer.body, { status: answer.status, headers: { 'content-type': answer.contentType, ...answer.headers } });
      Object.defineProperty(response, 'url', { value: url.href });
      return Promise.resolve(response);
    }
  };
  return { fetch, acquireContext, requests };
}

function createPipeline(options: { replayReferer: boolean }) {
  const network = extensionNetwork();
  const fetcher = new ManifestFetcher(network);
  const protocols = new ProtocolRegistry().register(new HlsAdapter({ fetcher })).register(new DashAdapter({ fetcher }));
  const manager = new DetectionManager({
    store: new SessionDetectionStore(new FakeStorageArea('session')),
    inspect: (url, context, kind) =>
      kind === 'progressive' ? inspectProgressiveFile(network, url, context) : inspectStream({ fetcher, protocols }, url, context),
    resolvePageInfo: createPageInfoResolver({
      getTab: () => Promise.resolve({ url: PAGE, title: 'StreamGrab progressive files' }),
      getFrameMetadata: () => Promise.resolve({ url: PAGE, isTopFrame: true, documentTitle: 'StreamGrab progressive files', videos: [] }),
      delay: () => Promise.resolve(),
    }),
    flushDelayMs: 0,
  });

  /** Plays NetworkMonitor: the page's request → classifier → candidate (with the Referer the page sent). */
  const observe = async (path: string, resourceType: 'media' | 'xmlhttprequest', timestamp: number): Promise<void> => {
    const { url, response } = pageRequest(path, resourceType === 'media' ? 'bytes=0-' : undefined);
    const length = response.headers?.['content-length'];
    const verdict = classifyResponse({
      url,
      method: 'GET',
      resourceType,
      statusCode: response.status,
      contentType: response.contentType,
      contentLength: length === undefined ? undefined : Number(length),
    });
    if (verdict.kind === 'ignore' || verdict.kind === 'probe') return;
    const candidate: DetectionCandidate = {
      tabId: 1,
      frameId: 0,
      url,
      requestContext: options.replayReferer ? { referer: PAGE } : {},
      timestamp,
    };
    if (verdict.kind === 'manifest') candidate.match = { protocol: verdict.protocol, evidence: verdict.evidence };
    else {
      candidate.match = { protocol: 'progressive', evidence: verdict.evidence };
      candidate.progressive = { container: verdict.container, ...(verdict.mimeType ? { mimeType: verdict.mimeType } : {}) };
    }
    await manager.handleCandidate(candidate);
  };

  /** Plays the content script: the page's <video>/<source> elements. */
  const domReport = async (): Promise<void> => {
    for (const fixture of PROGRESSIVE_FILES) {
      await manager.handleCandidate(
        domSourceCandidate(1, 0, options.replayReferer ? PAGE : undefined, {
          url: `${ORIGIN}${fixture.path}`,
          protocol: 'progressive',
          container: fixture.container,
          title: fixture.title,
        }, 0),
      );
    }
  };

  return { manager, observe, domReport, network };
}

const pathOf = (stream: DetectedStream) => new URL(stream.url).pathname;

describe('progressive detection on the fixture site', () => {
  it('lists every MP4/WebM file of the page once, with its details and request context, next to an HLS stream', async () => {
    const { manager, observe, domReport, network } = createPipeline({ replayReferer: true });
    await domReport();
    await observe(MASTER_PATH, 'xmlhttprequest', 1);
    // Media elements request their files (range after range), the page fetches an .mp4 by script.
    for (const [index, fixture] of PROGRESSIVE_FILES.entries()) {
      await observe(fixture.path, 'media', 10 + index);
      await observe(fixture.path, 'media', 20 + index);
    }
    await observe(MSE_SEGMENT_PATH, 'xmlhttprequest', 30);
    await manager.idle();

    const streams = await manager.getStreams(1);
    expect(streams.map((stream) => [pathOf(stream), stream.protocol, stream.status, stream.title])).toEqual([
      ['/files/sample.mp4', 'progressive', 'ready', 'MP4 sample'],
      ['/files/sample.webm', 'progressive', 'ready', 'WebM sample'],
      ['/files/protected.mp4', 'progressive', 'ready', 'Referer-protected MP4'],
      ['/files/go/redirect.mp4', 'progressive', 'ready', 'Redirected MP4'],
      ['/vod/movie/master.m3u8', 'hls', 'ready', 'StreamGrab progressive files'],
    ]);

    const [mp4, webm, protectedMp4, redirected, hls] = streams;
    expect(mp4).toMatchObject({
      evidence: ['dom', 'content-type'],
      requestContext: { referer: PAGE },
      progressive: { container: 'mp4', mimeType: 'video/mp4', bytes: files.mp4FastStart.length, acceptsRanges: true, fileName: 'sample.mp4' },
      media: { variants: [{ id: 'file' }], audioTracks: [] },
    });
    expect(webm?.progressive).toEqual({ container: 'webm', mimeType: 'video/webm', bytes: files.webm.length, acceptsRanges: true, fileName: 'sample.webm' });
    expect(protectedMp4?.progressive).toMatchObject({ bytes: files.mp4.length });
    // The redirect target is the same video: one entry, under the page's link.
    expect(redirected).toMatchObject({ childKeys: [`${ORIGIN}${REDIRECT_TARGET_PATH}`], progressive: { bytes: files.mp4Fragmented.length } });
    expect(hls?.manifest?.role).toBe('master');

    // Inspection read the first bytes only, with the page's Referer on the protected file.
    const inspections = network.requests.filter((request) => request.path.startsWith('/files/'));
    expect(inspections.every((request) => request.range === 'bytes=0-65535')).toBe(true);
    expect(inspections.filter((request) => request.path === '/files/protected.mp4')).toEqual([
      { path: '/files/protected.mp4', referer: PAGE, range: 'bytes=0-65535' },
    ]);
    expect(network.requests.some((request) => request.path === MSE_SEGMENT_PATH)).toBe(false);
  });

  it('shows a file the server refuses without the page context as unavailable, with the reason', async () => {
    const { manager, observe } = createPipeline({ replayReferer: false });
    await observe('/files/protected.mp4', 'media', 1);
    await observe('/files/sample.webm', 'media', 2);
    await manager.idle();
    const streams = await manager.getStreams(1);
    expect(streams.map((stream) => [pathOf(stream), stream.status])).toEqual([
      ['/files/protected.mp4', 'error'],
      ['/files/sample.webm', 'ready'],
    ]);
    expect(streams[0]).toMatchObject({ statusMessage: expect.stringContaining('Access denied (HTTP 403)') as string, progressive: { container: 'mp4' } });
  });
});
