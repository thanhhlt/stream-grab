import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@/core/models/detected-stream';
import { ManifestFetcher, type FetchFunction } from '@/core/network/manifest-fetcher';
import { HlsAdapter } from '@/core/protocols/hls/hls-adapter';
import { ProtocolRegistry } from '@/core/protocols/protocol-adapter';
import { StreamGrabError } from '@/shared/utils/errors';
import hlsMasterFairplay from '@tests/fixtures/manifests/hls/master-fairplay.m3u8?raw';
import hlsMasterMuxed from '@tests/fixtures/manifests/hls/master-muxed-audio.m3u8?raw';
import hlsMaster from '@tests/fixtures/manifests/hls/master.m3u8?raw';
import hlsFmp4 from '@tests/fixtures/manifests/hls/media-fmp4.m3u8?raw';
import hlsLive from '@tests/fixtures/manifests/hls/media-live.m3u8?raw';
import hlsTs from '@tests/fixtures/manifests/hls/media-ts.m3u8?raw';
import hlsWidevine from '@tests/fixtures/manifests/hls/media-widevine.m3u8?raw';

const MASTER = 'https://cdn.example.com/vod/movie/master.m3u8';
const V1080 = 'https://cdn.example.com/vod/movie/video/1080p/prog_index.m3u8';
const V720 = 'https://cdn2.example.com/vod/movie/video/720p/prog_index.m3u8?token=abc123';
const V360 = 'https://cdn.example.com/vod/shared/360p/prog_index.m3u8';
const AUDIO_EN = 'https://cdn.example.com/vod/movie/audio/en/prog_index.m3u8';
const AUDIO_FR = 'https://cdn.example.com/vod/movie/audio/fr/prog_index.m3u8';

type Route = string | { body: string; status?: number; finalUrl?: string };

/** A fake web server: URL → body, with request log and optional redirects. */
function createSite(routes: Record<string, Route>) {
  const requests: string[] = [];
  const contexts: [string, RequestContext][] = [];
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
    acquireContext: (url, context) => {
      contexts.push([url, context]);
      return Promise.resolve(() => Promise.resolve());
    },
  });
  return { requests, contexts, fetcher, count: (url: string) => requests.filter((request) => request === url).length };
}

const MOVIE_SITE: Record<string, Route> = {
  [MASTER]: hlsMaster,
  [V1080]: hlsTs,
  [V720]: hlsTs,
  [V360]: hlsTs,
  [AUDIO_EN]: hlsTs,
  [AUDIO_FR]: hlsTs,
};

async function rejection(promise: Promise<unknown>): Promise<StreamGrabError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StreamGrabError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('HlsAdapter', () => {
  describe('scenario: one HLS video with MPEG-TS segments', () => {
    it('parses a media playlist as a single variant and returns its ordered segments', async () => {
      const site = createSite({ [V1080]: hlsTs });
      const adapter = new HlsAdapter({ fetcher: site.fetcher });
      const manifest = await adapter.parseManifest(V1080);
      expect(manifest).toMatchObject({ protocol: 'hls', isLive: false, durationSec: 34.5, hls: { kind: 'media' }, childUrls: [] });
      const [variant] = await adapter.getAvailableVariants(manifest);
      if (!variant) throw new Error('no variant');
      const segments = await adapter.getSegments(manifest, variant);
      expect(segments.map((s) => [s.index, s.container, s.url.split('/').pop()])).toEqual([
        [0, 'mpeg-ts', 'segment_00000.ts'],
        [1, 'mpeg-ts', 'segment_00001.ts'],
        [2, 'mpeg-ts', 'segment_00002.ts?sig=xyz'],
        [3, 'mpeg-ts', 'segment_00003.ts'],
      ]);
      expect(site.count(V1080)).toBe(1); // parsed once, reused for segments
    });
  });

  describe('scenario: one HLS video with fMP4 segments', () => {
    it('returns the initialization section followed by byte-range media segments', async () => {
      const url = 'https://cdn.example.com/cmaf/video.m3u8';
      const adapter = new HlsAdapter({ fetcher: createSite({ [url]: hlsFmp4 }).fetcher });
      const manifest = await adapter.parseManifest(url);
      const segments = await adapter.getSegments(manifest, manifest.variants[0] ?? expect.fail());
      expect(segments.map((s) => [s.kind, s.container, s.byteRange?.offset])).toEqual([
        ['init', 'fmp4', 0],
        ['media', 'fmp4', 720],
        ['media', 'fmp4', 1049296],
        ['media', 'fmp4', undefined],
        ['media', 'fmp4', undefined],
      ]);
    });
  });

  describe('scenario: a manifest with multiple resolutions', () => {
    it('lists variants best first and takes duration and live state from the first variant', async () => {
      const site = createSite(MOVIE_SITE);
      const adapter = new HlsAdapter({ fetcher: site.fetcher });
      const manifest = await adapter.parseManifest(MASTER);
      expect(manifest).toMatchObject({ isLive: false, durationSec: 34.5, hls: { kind: 'master' } });
      expect((await adapter.getAvailableVariants(manifest)).map((v) => v.height)).toEqual([1080, 720, 360]);
      expect(manifest.childUrls).toContain(AUDIO_FR);
      expect(site.requests).toEqual([MASTER, V1080]);
    });

    it('adds the default audio track, an explicit one, or none', async () => {
      const adapter = new HlsAdapter({ fetcher: createSite(MOVIE_SITE).fetcher });
      const manifest = await adapter.parseManifest(MASTER);
      const variant720 = manifest.variants[1] ?? expect.fail();
      const tracksOf = async (audioTrackIds?: string[]) => {
        const segments = await adapter.getSegments(manifest, variant720, audioTrackIds ? { audioTrackIds } : {});
        return [...new Set(segments.map((s) => `${s.trackType}:${s.trackId}`))];
      };
      expect(await tracksOf()).toEqual(['main:main', 'audio:audio-0']);
      expect(await tracksOf(['audio-1'])).toEqual(['main:main', 'audio:audio-1']);
      expect(await tracksOf(['audio-0', 'audio-1'])).toEqual(['main:main', 'audio:audio-0', 'audio:audio-1']);
      expect(await tracksOf([])).toEqual(['main:main']);
    });

    it('keeps segment order per track, independent of how tracks are fetched', async () => {
      const adapter = new HlsAdapter({ fetcher: createSite(MOVIE_SITE).fetcher });
      const manifest = await adapter.parseManifest(MASTER);
      const segments = await adapter.getSegments(manifest, manifest.variants[0] ?? expect.fail());
      for (const trackId of ['main', 'audio-0']) {
        expect(segments.filter((s) => s.trackId === trackId).map((s) => s.index)).toEqual([0, 1, 2, 3]);
      }
      expect(new Set(segments.map((s) => s.id)).size).toBe(segments.length);
    });
  });

  it('handles audio muxed into the variant (rendition without URI)', async () => {
    const base = 'https://cdn.example.com/vod/movie/';
    const site = createSite({
      [`${base}master.m3u8`]: hlsMasterMuxed,
      [`${base}720p60.m3u8`]: hlsTs,
      [`${base}commentary.m3u8`]: hlsTs,
      [`${base}low.m3u8`]: hlsTs,
    });
    const adapter = new HlsAdapter({ fetcher: site.fetcher });
    const manifest = await adapter.parseManifest(`${base}master.m3u8`);
    const [hd, low] = manifest.variants;
    if (!hd || !low) throw new Error('variants missing');
    // Default track "Main" has no playlist: its audio is inside the variant's segments.
    expect(new Set((await adapter.getSegments(manifest, hd)).map((s) => s.trackId))).toEqual(new Set(['main']));
    expect(new Set((await adapter.getSegments(manifest, hd, { audioTrackIds: ['audio-1'] })).map((s) => s.trackId))).toEqual(
      new Set(['main', 'audio-1']),
    );
    expect((await rejection(adapter.getSegments(manifest, low, { audioTrackIds: ['audio-1'] }))).code).toBe('UNSUPPORTED');
  });

  describe('scenario: unsupported DRM-protected streams', () => {
    it('reports FairPlay from the multivariant playlist and never returns segments', async () => {
      const url = 'https://drm.example.com/master.m3u8';
      const site = createSite({ [url]: hlsMasterFairplay, 'https://drm.example.com/1080p.m3u8': hlsTs });
      const adapter = new HlsAdapter({ fetcher: site.fetcher });
      const manifest = await adapter.parseManifest(url);
      expect(manifest.drmSystems).toEqual(['fairplay']);
      expect(site.requests).toEqual([url]); // no need to look at variants
      const error = await rejection(adapter.getSegments(manifest, manifest.variants[0] ?? expect.fail()));
      expect(error.code).toBe('DRM_PROTECTED');
      expect(error.message).toContain('FairPlay');
    });

    it('detects Widevine keys declared only in the media playlist', async () => {
      const url = 'https://drm.example.com/wv.m3u8';
      const adapter = new HlsAdapter({ fetcher: createSite({ [url]: hlsWidevine }).fetcher });
      const manifest = await adapter.parseManifest(url);
      expect(manifest.drmSystems).toEqual(['widevine']);
      expect((await rejection(adapter.getSegments(manifest, manifest.variants[0] ?? expect.fail()))).code).toBe('DRM_PROTECTED');
    });
  });

  describe('scenario: expired manifest URLs', () => {
    it('explains expired or forbidden manifests', async () => {
      const adapter = new HlsAdapter({ fetcher: createSite({ [MASTER]: { body: 'Forbidden', status: 403 } }).fetcher });
      const error = await rejection(adapter.parseManifest(MASTER));
      expect(error.code).toBe('MANIFEST_UNAVAILABLE');
      expect(error.message).toMatch(/^Access denied \(HTTP 403\)/);
    });

    it('fails getSegments clearly when a variant playlist has expired', async () => {
      const adapter = new HlsAdapter({ fetcher: createSite({ ...MOVIE_SITE, [V360]: { body: '', status: 410 } }).fetcher });
      const manifest = await adapter.parseManifest(MASTER);
      const error = await rejection(adapter.getSegments(manifest, manifest.variants[2] ?? expect.fail()));
      expect(error).toMatchObject({ code: 'MANIFEST_UNAVAILABLE', message: 'Not found (HTTP 410). The link may have expired.' });
    });

    it('still describes the master when its first variant cannot be read', async () => {
      const adapter = new HlsAdapter({ fetcher: createSite({ [MASTER]: hlsMaster }).fetcher });
      const manifest = await adapter.parseManifest(MASTER);
      expect(manifest.variants).toHaveLength(3);
      expect(manifest.durationSec).toBeUndefined();
    });
  });

  it('marks live playlists and returns the current window', async () => {
    const url = 'https://live.example.com/channel.m3u8';
    const adapter = new HlsAdapter({ fetcher: createSite({ [url]: hlsLive }).fetcher });
    const manifest = await adapter.parseManifest(url);
    expect(manifest).toMatchObject({ isLive: true });
    expect(manifest.durationSec).toBeUndefined();
    expect(await adapter.getSegments(manifest, manifest.variants[0] ?? expect.fail())).toHaveLength(3);
  });

  it('rejects bodies that are not HLS playlists as invalid', async () => {
    const url = 'https://a.example/x.m3u8';
    const adapter = new HlsAdapter({ fetcher: createSite({ [url]: '<html>login</html>' }).fetcher });
    expect((await rejection(adapter.parseManifest(url))).code).toBe('MANIFEST_INVALID');
  });

  describe('requests', () => {
    it('reuses a prefetched body instead of downloading the manifest again', async () => {
      const site = createSite(MOVIE_SITE);
      const adapter = new HlsAdapter({ fetcher: site.fetcher });
      await adapter.parseManifest(MASTER, { prefetched: { text: hlsMaster, finalUrl: MASTER } });
      expect(site.count(MASTER)).toBe(0);
    });

    it('caches playlists, so repeated parses and segment requests do not refetch', async () => {
      const site = createSite(MOVIE_SITE);
      const adapter = new HlsAdapter({ fetcher: site.fetcher });
      const first = await adapter.parseManifest(MASTER);
      await adapter.parseManifest(MASTER);
      await adapter.getSegments(first, first.variants[0] ?? expect.fail());
      expect(site.count(MASTER)).toBe(1);
      expect(site.count(V1080)).toBe(1);
      expect(site.count(AUDIO_EN)).toBe(1);
    });

    it('refreshes live playlists after half a target duration', async () => {
      const url = 'https://live.example.com/channel.m3u8';
      const site = createSite({ [url]: hlsLive });
      let now = 0;
      const adapter = new HlsAdapter({ fetcher: site.fetcher, now: () => now });
      await adapter.parseManifest(url);
      now += 1000;
      await adapter.parseManifest(url);
      now += 1500; // target duration 4 s → 2 s lifetime
      await adapter.parseManifest(url);
      expect(site.count(url)).toBe(2);
    });

    it('resolves relative references against the URL after redirects', async () => {
      const finalUrl = 'https://edge-7.cdn.example.net/vod/movie/master.m3u8';
      const site = createSite({ [MASTER]: { body: hlsMaster, finalUrl } });
      const manifest = await new HlsAdapter({ fetcher: site.fetcher }).parseManifest(MASTER);
      expect(manifest).toMatchObject({ requestedUrl: MASTER, url: finalUrl });
      expect(manifest.variants[0]?.hls?.playlistUrl).toBe('https://edge-7.cdn.example.net/vod/movie/video/1080p/prog_index.m3u8');
    });

    it('replays the page request context on every playlist request', async () => {
      const site = createSite(MOVIE_SITE);
      const adapter = new HlsAdapter({ fetcher: site.fetcher });
      const context = { referer: 'https://site.example/watch' };
      const manifest = await adapter.parseManifest(MASTER, { context });
      await adapter.getSegments(manifest, manifest.variants[1] ?? expect.fail());
      expect(site.contexts.map(([url]) => url)).toEqual([MASTER, V1080, V720, AUDIO_EN]);
      expect(site.contexts.every(([, used]) => used === context)).toBe(true);
    });

    it('lets one caller abort without failing others waiting for the same playlist', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fetch = vi.fn<FetchFunction>(async () => {
        await gate;
        return new Response(hlsTs);
      });
      const adapter = new HlsAdapter({ fetcher: new ManifestFetcher({ fetch }) });
      const controller = new AbortController();
      const aborted = adapter.parseManifest(V1080, { signal: controller.signal });
      const patient = adapter.parseManifest(V1080);
      controller.abort();
      release();
      await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
      await expect(patient).resolves.toMatchObject({ durationSec: 34.5 });
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  it('refuses variants that do not belong to the manifest', async () => {
    const adapter = new HlsAdapter({ fetcher: createSite(MOVIE_SITE).fetcher });
    const manifest = await adapter.parseManifest(MASTER);
    const foreign = { ...(manifest.variants[0] ?? expect.fail()), id: 'video-99' };
    expect((await rejection(adapter.getSegments(manifest, foreign))).code).toBe('UNSUPPORTED');
  });

  it('is chosen by URL or Content-Type through the registry', () => {
    const adapter = new HlsAdapter({ fetcher: createSite({}).fetcher });
    const registry = new ProtocolRegistry().register(adapter);
    expect(registry.forUrl('https://a.example/x.m3u8?token=1')).toBe(adapter);
    expect(registry.forUrl('https://a.example/play', 'application/vnd.apple.mpegurl')).toBe(adapter);
    expect(registry.forUrl('https://a.example/x.mpd')).toBeUndefined();
    expect(registry.forUrl('https://a.example/x.m3u8', 'application/dash+xml')).toBeUndefined();
    expect(registry.forProtocol('hls')).toBe(adapter);
  });
});
