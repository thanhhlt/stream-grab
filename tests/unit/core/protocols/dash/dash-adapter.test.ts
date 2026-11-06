import { describe, expect, it } from 'vitest';
import type { RequestContext } from '@/core/models/detected-stream';
import { ManifestFetcher, type FetchFunction } from '@/core/network/manifest-fetcher';
import { DashAdapter } from '@/core/protocols/dash/dash-adapter';
import { HlsAdapter } from '@/core/protocols/hls/hls-adapter';
import { ProtocolRegistry } from '@/core/protocols/protocol-adapter';
import { StreamGrabError } from '@/shared/utils/errors';
import dashDrm from '@tests/fixtures/manifests/dash/drm.mpd?raw';
import dashDynamic from '@tests/fixtures/manifests/dash/dynamic.mpd?raw';
import dashMultiAudio from '@tests/fixtures/manifests/dash/multi-audio.mpd?raw';
import dashSegmentBase from '@tests/fixtures/manifests/dash/segment-base.mpd?raw';
import dashStatic from '@tests/fixtures/manifests/dash/static-separate-av.mpd?raw';

const MPD = 'https://cdn.example.com/vod/movie/manifest.mpd';

type Route = string | { body: string; status?: number; finalUrl?: string };

function createSite(routes: Record<string, Route>) {
  const requests: string[] = [];
  const contexts: RequestContext[] = [];
  const fetch: FetchFunction = (url) => {
    requests.push(url);
    const route = routes[url];
    if (route === undefined) return Promise.resolve(new Response('missing', { status: 404 }));
    const { body, status = 200, finalUrl } = typeof route === 'string' ? { body: route } : route;
    const response = new Response(body, { status });
    if (finalUrl !== undefined) Object.defineProperty(response, 'url', { value: finalUrl });
    return Promise.resolve(response);
  };
  const fetcher = new ManifestFetcher({
    fetch,
    acquireContext: (_url, context) => {
      contexts.push(context);
      return Promise.resolve(() => Promise.resolve());
    },
  });
  return { requests, contexts, fetcher };
}

async function rejection(promise: Promise<unknown>): Promise<StreamGrabError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StreamGrabError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

const tracksOf = (segments: { trackType: string; trackId: string }[]) => [
  ...new Set(segments.map((s) => `${s.trackType}:${s.trackId}`)),
];

describe('DashAdapter', () => {
  describe('scenario: one DASH video with separate audio and video', () => {
    it('describes the presentation and returns video and default audio segments, each in order', async () => {
      const adapter = new DashAdapter({ fetcher: createSite({ [MPD]: dashStatic }).fetcher });
      const manifest = await adapter.parseManifest(MPD);
      expect(manifest).toMatchObject({ protocol: 'dash', isLive: false, drmSystems: [], childUrls: [] });
      expect(manifest.durationSec).toBeCloseTo(634.567, 3);
      const [best] = await adapter.getAvailableVariants(manifest);
      if (!best) throw new Error('no variant');
      expect(best.height).toBe(1080);

      const segments = await adapter.getSegments(manifest, best);
      expect(tracksOf(segments)).toEqual(['main:main', 'audio:audio-0']);
      for (const trackId of ['main', 'audio-0']) {
        const track = segments.filter((s) => s.trackId === trackId);
        expect(track.map((s) => s.index)).toEqual(track.map((_, i) => i));
        expect(track[0]?.kind).toBe('init');
        expect(track.slice(1).every((s) => s.kind === 'media' && s.initSegmentId === `${trackId}:0`)).toBe(true);
      }
      expect(new Set(segments.map((s) => s.id)).size).toBe(segments.length);
    });

    it('selects another language, several, or none', async () => {
      const adapter = new DashAdapter({ fetcher: createSite({ [MPD]: dashMultiAudio }).fetcher });
      const manifest = await adapter.parseManifest(MPD);
      const hd = manifest.variants[0] ?? expect.fail();
      expect(tracksOf(await adapter.getSegments(manifest, hd))).toEqual(['main:main', 'audio:audio-1']); // English: role main
      expect(tracksOf(await adapter.getSegments(manifest, hd, { audioTrackIds: ['audio-0'] }))).toEqual([
        'main:main',
        'audio:audio-0',
      ]);
      expect(tracksOf(await adapter.getSegments(manifest, hd, { audioTrackIds: ['audio-0', 'audio-1'] }))).toEqual([
        'main:main',
        'audio:audio-0',
        'audio:audio-1',
      ]);
      expect(tracksOf(await adapter.getSegments(manifest, hd, { audioTrackIds: [] }))).toEqual(['main:main']);
      expect((await rejection(adapter.getSegments(manifest, hd, { audioTrackIds: ['audio-9'] }))).code).toBe('UNSUPPORTED');
    });
  });

  it('does not add separate audio to a representation that already carries audio', async () => {
    const muxed = dashStatic.replace('codecs="avc1.640028"', 'codecs="avc1.640028,mp4a.40.2"');
    const adapter = new DashAdapter({ fetcher: createSite({ [MPD]: muxed }).fetcher });
    const manifest = await adapter.parseManifest(MPD);
    const [best] = await adapter.getAvailableVariants(manifest);
    expect(tracksOf(await adapter.getSegments(manifest, best ?? expect.fail()))).toEqual(['main:main']);
  });

  it('returns SegmentBase representations as whole files', async () => {
    const adapter = new DashAdapter({ fetcher: createSite({ [MPD]: dashSegmentBase }).fetcher });
    const manifest = await adapter.parseManifest(MPD);
    const segments = await adapter.getSegments(manifest, manifest.variants[0] ?? expect.fail());
    expect(segments.map((s) => [s.trackId, s.url.split('/').pop(), s.byteRange])).toEqual([
      ['main', 'video_720.mp4', undefined],
      ['audio-0', 'audio_en.mp4', undefined],
    ]);
  });

  describe('scenario: unsupported DRM-protected streams', () => {
    it('reports DRM and never returns segments', async () => {
      const adapter = new DashAdapter({ fetcher: createSite({ [MPD]: dashDrm }).fetcher });
      const manifest = await adapter.parseManifest(MPD);
      expect(manifest.drmSystems).toEqual(['widevine', 'playready']);
      const error = await rejection(adapter.getSegments(manifest, manifest.variants[0] ?? expect.fail()));
      expect(error.code).toBe('DRM_PROTECTED');
      expect(error.message).toContain('Widevine / PlayReady');
    });
  });

  it('marks dynamic presentations live and re-reads them as their window moves', async () => {
    const site = createSite({ [MPD]: dashDynamic });
    let now = Date.parse('2026-11-05T10:00:10Z');
    const adapter = new DashAdapter({ fetcher: site.fetcher, now: () => now });
    const manifest = await adapter.parseManifest(MPD);
    expect(manifest.isLive).toBe(true);
    expect(manifest.durationSec).toBeUndefined();
    const first = await adapter.getSegments(manifest, manifest.variants[0] ?? expect.fail());
    now += 10_000; // minimumUpdatePeriod is 2 s
    const later = await adapter.getSegments(manifest, manifest.variants[0] ?? expect.fail());
    expect(site.requests).toEqual([MPD, MPD]);
    expect(later.at(-1)?.url).not.toBe(first.at(-1)?.url);
  });

  describe('scenario: expired manifest URLs', () => {
    it('explains expired links', async () => {
      const adapter = new DashAdapter({ fetcher: createSite({ [MPD]: { body: '', status: 410 } }).fetcher });
      const error = await rejection(adapter.parseManifest(MPD));
      expect(error).toMatchObject({ code: 'MANIFEST_UNAVAILABLE', message: 'Not found (HTTP 410). The link may have expired.' });
    });
  });

  it('rejects bodies that are not MPDs', async () => {
    const adapter = new DashAdapter({ fetcher: createSite({ [MPD]: '<html>login</html>' }).fetcher });
    expect((await rejection(adapter.parseManifest(MPD))).code).toBe('MANIFEST_INVALID');
  });

  describe('requests', () => {
    it('parses an MPD once for detection, variants and segments', async () => {
      const site = createSite({ [MPD]: dashStatic });
      const adapter = new DashAdapter({ fetcher: site.fetcher });
      const manifest = await adapter.parseManifest(MPD, { prefetched: { text: dashStatic, finalUrl: MPD } });
      await adapter.getSegments(manifest, manifest.variants[0] ?? expect.fail());
      await adapter.getSegments(manifest, manifest.variants[1] ?? expect.fail());
      expect(site.requests).toEqual([]);
    });

    it('resolves references against the post-redirect URL and finds the cached parse under it', async () => {
      const finalUrl = 'https://edge.cdn.example.net/vod/manifest.mpd';
      const site = createSite({ [MPD]: { body: dashStatic, finalUrl } });
      const adapter = new DashAdapter({ fetcher: site.fetcher });
      const manifest = await adapter.parseManifest(MPD);
      const segments = await adapter.getSegments(manifest, manifest.variants[0] ?? expect.fail());
      expect(segments[0]?.url).toBe('https://cdn.example.com/vod/movie/video/1080p/init.mp4'); // the MPD has an absolute BaseURL
      expect(manifest.url).toBe(finalUrl);
      expect(site.requests).toEqual([MPD]);
    });

    it('replays the page request context', async () => {
      const site = createSite({ [MPD]: dashStatic });
      const context = { referer: 'https://site.example/watch', origin: 'https://site.example' };
      await new DashAdapter({ fetcher: site.fetcher }).parseManifest(MPD, { context });
      expect(site.contexts).toEqual([context]);
    });

    it('lets a caller abort waiting', async () => {
      const controller = new AbortController();
      controller.abort();
      const adapter = new DashAdapter({ fetcher: createSite({ [MPD]: dashStatic }).fetcher });
      await expect(adapter.parseManifest(MPD, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    });
  });

  it('refuses variants that do not belong to the manifest', async () => {
    const adapter = new DashAdapter({ fetcher: createSite({ [MPD]: dashStatic }).fetcher });
    const manifest = await adapter.parseManifest(MPD);
    const foreign = { ...(manifest.variants[0] ?? expect.fail()), id: 'video-42' };
    expect((await rejection(adapter.getSegments(manifest, foreign))).code).toBe('UNSUPPORTED');
  });

  it('is chosen by URL or Content-Type through the registry, next to HLS', () => {
    const { fetcher } = createSite({});
    const dash = new DashAdapter({ fetcher });
    const hls = new HlsAdapter({ fetcher });
    const registry = new ProtocolRegistry().register(hls).register(dash);
    expect(registry.forUrl('https://a.example/stream.mpd?token=1')).toBe(dash);
    expect(registry.forUrl('https://a.example/video.ism/manifest(format=mpd-time-cmaf)')).toBe(dash);
    expect(registry.forUrl('https://a.example/play', 'application/dash+xml')).toBe(dash);
    expect(registry.forUrl('https://a.example/x.m3u8')).toBe(hls);
    expect(registry.forProtocol('dash')).toBe(dash);
  });
});
