import { describe, expect, it, vi } from 'vitest';
import { inspectStream } from '@/core/detection/stream-inspector';
import { ManifestFetcher, type FetchFunction } from '@/core/network/manifest-fetcher';
import { DashAdapter } from '@/core/protocols/dash/dash-adapter';
import { HlsAdapter } from '@/core/protocols/hls/hls-adapter';
import { ProtocolRegistry } from '@/core/protocols/protocol-adapter';
import dashDrm from '@tests/fixtures/manifests/dash/drm.mpd?raw';
import hlsMasterFairplay from '@tests/fixtures/manifests/hls/master-fairplay.m3u8?raw';
import hlsMaster from '@tests/fixtures/manifests/hls/master.m3u8?raw';
import hlsLive from '@tests/fixtures/manifests/hls/media-live.m3u8?raw';

const MASTER = 'https://cdn.example.com/vod/movie/master.m3u8';
const FIRST_VARIANT = 'https://cdn.example.com/vod/movie/video/1080p/prog_index.m3u8';

function setup(bodies: Record<string, string | { body: string; status: number }>) {
  const fetch = vi.fn<FetchFunction>((url) => {
    const entry = bodies[url];
    if (entry === undefined) return Promise.resolve(new Response('missing', { status: 404 }));
    return Promise.resolve(typeof entry === 'string' ? new Response(entry) : new Response(entry.body, { status: entry.status }));
  });
  const fetcher = new ManifestFetcher({ fetch });
  const protocols = new ProtocolRegistry().register(new HlsAdapter({ fetcher })).register(new DashAdapter({ fetcher }));
  return { fetch, deps: { fetcher, protocols } };
}

describe('inspectStream', () => {
  it('parses HLS through the adapter, reusing the downloaded master and reading the first variant', async () => {
    const { fetch, deps } = setup({ [MASTER]: hlsMaster, [FIRST_VARIANT]: hlsLive });
    const outcome = await inspectStream(deps, MASTER, {});
    expect(outcome).toMatchObject({
      kind: 'manifest',
      info: { protocol: 'hls', role: 'master', live: true, media: { variants: [{ height: 1080 }, { height: 720 }, { height: 360 }] } },
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([MASTER, FIRST_VARIANT]);
  });

  it('keeps the master result when the variant cannot be fetched', async () => {
    const { deps } = setup({ [MASTER]: hlsMaster });
    await expect(inspectStream(deps, MASTER, {})).resolves.toMatchObject({
      kind: 'manifest',
      info: { role: 'master', live: false },
    });
  });

  it('does not fetch variants when the master already declares DRM', async () => {
    const { fetch, deps } = setup({ 'https://a.example/m.m3u8': hlsMasterFairplay });
    const outcome = await inspectStream(deps, 'https://a.example/m.m3u8', {});
    expect(outcome).toMatchObject({ kind: 'manifest', info: { drmSystems: ['fairplay'] } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('parses DASH through the DASH adapter', async () => {
    const { deps } = setup({ 'https://a.example/m.mpd': dashDrm });
    await expect(inspectStream(deps, 'https://a.example/m.mpd', {})).resolves.toMatchObject({
      kind: 'manifest',
      info: { protocol: 'dash', drmSystems: ['widevine', 'playready'] },
    });
  });

  it('explains expired or forbidden links', async () => {
    const { deps } = setup({ 'https://a.example/x.m3u8': { body: '', status: 403 } });
    await expect(inspectStream(deps, 'https://a.example/gone.m3u8', {})).resolves.toEqual({
      kind: 'failed',
      reason: 'Not found (HTTP 404). The link may have expired.',
    });
    await expect(inspectStream(deps, 'https://a.example/x.m3u8', {})).resolves.toMatchObject({
      kind: 'failed',
      reason: expect.stringContaining('HTTP 403') as unknown,
    });
  });

  it('reports bodies that are not manifests, including plain M3U', async () => {
    const { deps } = setup({
      'https://a.example/x': '<html>login</html>',
      'https://a.example/radio.m3u': '#EXTM3U\n#EXTINF:-1,Radio\nhttp://radio.example/stream',
    });
    expect((await inspectStream(deps, 'https://a.example/x', {})).kind).toBe('not-manifest');
    expect((await inspectStream(deps, 'https://a.example/radio.m3u', {})).kind).toBe('not-manifest');
  });
});
