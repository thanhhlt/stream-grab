import { describe, expect, it } from 'vitest';
import { createPageInfoResolver } from '@/background/page-info';
import { DetectionManager, type DetectionCandidate } from '@/core/detection/detection-manager';
import { SessionDetectionStore } from '@/core/detection/detection-store';
import { domSourceCandidate } from '@/core/detection/dom-candidate';
import { ManifestFetcher, type FetchFunction } from '@/core/network/manifest-fetcher';
import { classifyResponse } from '@/core/detection/manifest-detector';
import { inspectStream } from '@/core/detection/stream-inspector';
import { DashAdapter } from '@/core/protocols/dash/dash-adapter';
import { HlsAdapter } from '@/core/protocols/hls/hls-adapter';
import { ProtocolRegistry } from '@/core/protocols/protocol-adapter';
import type { FrameMetadata } from '@/shared/types/page-metadata';
import { FakeStorageArea } from '@tests/fakes/fake-storage';
import { createFixtureRouter, DOM_SOURCE_PATH, PAGE_REQUESTS } from '@tests/fixtures/fixture-routes';
import dashDrm from '@tests/fixtures/manifests/dash/drm.mpd?raw';
import dashStatic from '@tests/fixtures/manifests/dash/static-separate-av.mpd?raw';
import hlsMaster from '@tests/fixtures/manifests/hls/master.m3u8?raw';
import hlsFmp4 from '@tests/fixtures/manifests/hls/media-fmp4.m3u8?raw';
import hlsTs from '@tests/fixtures/manifests/hls/media-ts.m3u8?raw';

/**
 * Scenario "a page containing multiple streaming videos", end to end without
 * Chrome: the fixture site's requests go through the real response classifier,
 * manifest fetcher, inspector and detection manager. Only the browser parts
 * (webRequest events, content-script messaging, storage) are simulated.
 * The same page can be checked by hand: `npm run fixtures`.
 */

const ORIGIN = 'http://localhost:5180';
const MANIFESTS: Record<string, string> = {
  'hls/master.m3u8': hlsMaster,
  'hls/media-ts.m3u8': hlsTs,
  'hls/media-fmp4.m3u8': hlsFmp4,
  'dash/static-separate-av.mpd': dashStatic,
  'dash/drm.mpd': dashDrm,
};
const route = createFixtureRouter({
  manifest: (path) => {
    const text = MANIFESTS[path];
    if (text === undefined) throw new Error(`missing fixture ${path}`);
    return text;
  },
  page: () => '<!doctype html>',
});

/** The site as the extension's fetch sees it. */
const siteFetch: FetchFunction = (input) => {
  const response = route(new URL(input).pathname);
  return Promise.resolve(
    new Response(response.body, { status: response.status, headers: { 'content-type': response.contentType } }),
  );
};

/** What the content scripts of the two frames would report. */
const FRAMES: Record<number, FrameMetadata> = {
  0: {
    url: `${ORIGIN}/`,
    isTopFrame: true,
    documentTitle: 'StreamGrab detection test page',
    videos: [{ title: 'Main feature' }, { title: 'Native HLS sample' }],
  },
  1: { url: `${ORIGIN}/embed/dash`, isTopFrame: false, documentTitle: 'Sintel trailer (embed)', videos: [{}] },
};

function createPipeline(tabId: number) {
  const fetcher = new ManifestFetcher({ fetch: siteFetch });
  const protocols = new ProtocolRegistry().register(new HlsAdapter({ fetcher })).register(new DashAdapter({ fetcher }));
  const manager = new DetectionManager({
    store: new SessionDetectionStore(new FakeStorageArea('session')),
    inspect: (url, context) => inspectStream({ fetcher, protocols }, url, context),
    resolvePageInfo: createPageInfoResolver({
      getTab: () => Promise.resolve({ url: `${ORIGIN}/`, title: 'StreamGrab detection test page' }),
      getFrameMetadata: (_tab, frameId) => Promise.resolve(FRAMES[frameId]),
      delay: () => Promise.resolve(),
    }),
    flushDelayMs: 0,
  });

  /** Plays the role of NetworkMonitor: response metadata → classifier → candidate. */
  const observe = async (path: string, frameId: number, timestamp: number): Promise<void> => {
    const url = `${ORIGIN}${path}`;
    const response = route(new URL(url).pathname);
    const verdict = classifyResponse({
      url,
      method: 'GET',
      resourceType: 'xmlhttprequest',
      statusCode: response.status,
      contentType: response.contentType,
    });
    if (verdict.kind === 'ignore' || verdict.kind === 'subtitle') return;
    const candidate: DetectionCandidate = {
      tabId,
      frameId,
      url,
      requestContext: { referer: `${ORIGIN}/` },
      timestamp,
    };
    if (verdict.kind === 'manifest') candidate.match = { protocol: verdict.protocol, evidence: verdict.evidence };
    await manager.handleCandidate(candidate);
  };

  return { manager, observe };
}

describe('detection pipeline on the fixture site', () => {
  it('lists each video of a multi-video page exactly once, with protocol, status and title', async () => {
    const { manager, observe } = createPipeline(1);
    for (const [index, request] of PAGE_REQUESTS.entries()) await observe(request.path, request.frameId, index);
    await manager.handleCandidate(
      domSourceCandidate(1, 0, `${ORIGIN}/`, { url: `${ORIGIN}${DOM_SOURCE_PATH}`, protocol: 'hls', title: 'Native HLS sample' }, 99),
    );
    await manager.idle();

    const streams = await manager.getStreams(1);
    const summary = streams.map((s) => ({
      path: new URL(s.url).pathname,
      protocol: s.protocol,
      status: s.status,
      title: s.title,
      evidence: s.evidence,
      role: s.manifest?.role,
    }));
    expect(summary).toEqual([
      {
        path: '/vod/movie/master.m3u8',
        protocol: 'hls',
        status: 'ready',
        title: 'StreamGrab detection test page',
        evidence: ['content-type'],
        role: 'master',
      },
      {
        path: '/api/stream/42/play',
        protocol: 'hls',
        status: 'ready',
        title: 'StreamGrab detection test page',
        evidence: ['content-type'],
        role: 'media',
      },
      {
        path: '/api/video/7/playlist',
        protocol: 'hls',
        status: 'ready',
        title: 'StreamGrab detection test page',
        evidence: ['content'],
        role: 'media',
      },
      {
        path: '/drm/movie.mpd',
        protocol: 'dash',
        status: 'drm',
        title: 'StreamGrab detection test page',
        evidence: ['content-type'],
        role: 'presentation',
      },
      {
        path: '/dash/sintel/stream.mpd',
        protocol: 'dash',
        status: 'ready',
        title: 'Sintel trailer (embed)',
        evidence: ['content-type'],
        role: 'presentation',
      },
      {
        path: '/native/master.m3u8',
        protocol: 'hls',
        status: 'ready',
        title: 'Native HLS sample',
        evidence: ['dom'],
        role: 'master',
      },
    ]);
    // The master was seen twice with rotated tokens: one entry, freshest URL.
    expect(streams[0]?.url).toBe(`${ORIGIN}/vod/movie/master.m3u8?token=def&expires=1800000000`);

    // Phase 3: HLS streams carry what the parser found (qualities, duration, audio tracks).
    expect(streams[0]?.media).toEqual({
      durationSec: 34.5,
      variants: [
        expect.objectContaining({ height: 1080, videoCodec: 'avc1.640028', audioCodec: 'mp4a.40.2' }),
        expect.objectContaining({ height: 720 }),
        expect.objectContaining({ height: 360 }),
      ],
      audioTracks: [
        { id: 'audio-0', name: 'English', language: 'en', isDefault: true },
        { id: 'audio-1', name: 'Français, stéréo', language: 'fr', isDefault: false },
      ],
    });
    // fMP4 playlist served as text/plain: 3 × 6.006 s + 2.002 s.
    expect(streams[2]?.media?.durationSec).toBeCloseTo(20.02, 6);
    expect(streams[2]?.media?.variants).toEqual([{ id: 'video-0', audioOnly: false, audioTrackIds: [] }]);

    // Phase 4: DASH streams too (the iframe's MPD: three video representations, separate English audio).
    const sintel = streams[4]?.media;
    expect(sintel?.durationSec).toBeCloseTo(634.567, 3);
    expect(sintel?.variants.map((variant) => [variant.height, variant.videoCodec])).toEqual([
      [1080, 'avc1.640028'],
      [720, 'avc1.64001f'],
      [360, 'avc1.4d401e'],
    ]);
    expect(sintel?.audioTracks).toEqual([{ id: 'audio-0', name: 'en', language: 'en', isDefault: true, codec: 'mp4a.40.2' }]);
    // The DRM-protected MPD is parsed too, but stays unsupported.
    expect(streams[3]).toMatchObject({ status: 'drm', media: { variants: [{ height: 1080 }] } });
  });
});
