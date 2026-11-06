import { describe, expect, it, vi } from 'vitest';
import {
  DetectionManager,
  type DetectionCandidate,
  type DetectionLimits,
  type PageInfo,
} from '@/core/detection/detection-manager';
import { detectionStorageKey, SessionDetectionStore } from '@/core/detection/detection-store';
import { inspectManifest } from '@/core/detection/manifest-inspector';
import type { InspectionOutcome } from '@/core/detection/stream-inspector';
import type { RequestContext } from '@/core/models/detected-stream';
import dashDrm from '@tests/fixtures/manifests/dash/drm.mpd?raw';
import dashStatic from '@tests/fixtures/manifests/dash/static-separate-av.mpd?raw';
import hlsMaster from '@tests/fixtures/manifests/hls/master.m3u8?raw';
import hlsTs from '@tests/fixtures/manifests/hls/media-ts.m3u8?raw';
import { FakeStorageArea } from '@tests/fakes/fake-storage';

const MASTER = 'https://cdn.example.com/vod/movie/master.m3u8';
const VARIANTS = [
  'https://cdn.example.com/vod/movie/video/1080p/prog_index.m3u8',
  'https://cdn2.example.com/vod/movie/video/720p/prog_index.m3u8?token=abc123',
  'https://cdn.example.com/vod/shared/360p/prog_index.m3u8',
  'https://cdn.example.com/vod/movie/audio/en/prog_index.m3u8',
];

function manifest(text: string, url: string): InspectionOutcome {
  const result = inspectManifest(text, url);
  if (!result.ok) throw new Error(result.reason);
  return { kind: 'manifest', info: result.info, finalUrl: url };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type Outcomes = Record<string, InspectionOutcome | (() => Promise<InspectionOutcome>)>;

function setup(
  options: { outcomes?: Outcomes; pageInfo?: PageInfo; limits?: Partial<DetectionLimits>; area?: FakeStorageArea } = {},
) {
  const outcomes: Outcomes = options.outcomes ?? {};
  const area = options.area ?? new FakeStorageArea('session');
  let clock = 1_000;
  const inspect = vi.fn((url: string, _context: RequestContext): Promise<InspectionOutcome> => {
    const outcome = outcomes[url];
    if (typeof outcome === 'function') return outcome();
    return Promise.resolve(outcome ?? { kind: 'failed', reason: 'no fixture' });
  });
  const resolvePageInfo = vi.fn(() => Promise.resolve(options.pageInfo ?? {}));
  const badge = new Map<number, number>();
  const manager = new DetectionManager({
    store: new SessionDetectionStore(area),
    inspect,
    resolvePageInfo,
    onTabChanged: (tabId, streams) => badge.set(tabId, streams.length),
    now: () => clock,
    flushDelayMs: 0,
    ...(options.limits ? { limits: options.limits } : {}),
  });
  return {
    manager,
    area,
    inspect,
    resolvePageInfo,
    badge,
    outcomes,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function candidate(url: string, overrides: Partial<DetectionCandidate> = {}): DetectionCandidate {
  return {
    tabId: 1,
    frameId: 0,
    url,
    match: { protocol: url.includes('.mpd') ? 'dash' : 'hls', evidence: 'extension' },
    requestContext: {},
    timestamp: 1_000,
    ...overrides,
  };
}

describe('DetectionManager', () => {
  it('lists a manifest immediately as pending, then ready after inspection, and persists it', async () => {
    const pending = deferred<InspectionOutcome>();
    const { manager, area, badge } = setup({ outcomes: { [MASTER]: () => pending.promise } });

    await manager.handleCandidate(candidate(MASTER));
    expect(await manager.getStreams(1)).toMatchObject([{ url: MASTER, status: 'pending', protocol: 'hls' }]);

    pending.resolve(manifest(hlsMaster, MASTER));
    await manager.idle();
    const [stream] = await manager.getStreams(1);
    expect(stream).toMatchObject({ status: 'ready', manifest: { role: 'master', live: false, drmSystems: [] } });
    expect(area.data.get(detectionStorageKey(1))).toMatchObject({ version: 1, tabId: 1, streams: [{ id: stream?.id }] });
    expect(badge.get(1)).toBe(1);
  });

  it('lists every video of a page with several players (HLS and DASH)', async () => {
    const other = 'https://media.example.org/hls/trailer/index.m3u8';
    const dash = 'https://dash.example.net/content/stream.mpd';
    const { manager } = setup({
      outcomes: {
        [MASTER]: manifest(hlsMaster, MASTER),
        [other]: manifest(hlsTs, other),
        [dash]: manifest(dashStatic, dash),
      },
    });
    await manager.handleCandidate(candidate(MASTER, { timestamp: 1 }));
    await manager.handleCandidate(candidate(other, { timestamp: 2, frameId: 3 }));
    await manager.handleCandidate(candidate(dash, { timestamp: 3, frameId: 4 }));
    await manager.idle();

    const streams = await manager.getStreams(1);
    expect(streams.map((s) => [s.url, s.protocol, s.status, s.frameId])).toEqual([
      [MASTER, 'hls', 'ready', 0],
      [other, 'hls', 'ready', 3],
      [dash, 'dash', 'ready', 4],
    ]);
  });

  it('folds variant playlists loaded before the master was inspected under the master', async () => {
    const masterInspection = deferred<InspectionOutcome>();
    const outcomes: Outcomes = { [MASTER]: () => masterInspection.promise };
    for (const variant of VARIANTS) outcomes[variant] = manifest(hlsTs, variant);
    const { manager } = setup({ outcomes });

    await manager.handleCandidate(candidate(MASTER));
    for (const variant of VARIANTS) await manager.handleCandidate(candidate(variant));
    expect(await manager.getStreams(1)).toHaveLength(1 + VARIANTS.length);

    masterInspection.resolve(manifest(hlsMaster, MASTER));
    await manager.idle();
    expect((await manager.getStreams(1)).map((s) => s.url)).toEqual([MASTER]);
  });

  it('ignores variant playlists requested after the master was inspected, even with fresh tokens', async () => {
    const { manager, inspect } = setup({ outcomes: { [MASTER]: manifest(hlsMaster, MASTER) } });
    await manager.handleCandidate(candidate(MASTER));
    await manager.idle();
    await manager.handleCandidate(candidate(`${VARIANTS[0] ?? ''}?token=fresh`));
    await manager.handleCandidate(candidate('https://cdn2.example.com/vod/movie/video/720p/prog_index.m3u8?token=other'));
    await manager.idle();
    expect(await manager.getStreams(1)).toHaveLength(1);
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('deduplicates one manifest requested with rotating tokens and keeps the freshest URL', async () => {
    const first = `${MASTER}?token=aaa&expires=1`;
    const second = `${MASTER}?expires=2&token=bbb`;
    const { manager, inspect } = setup({ outcomes: { [first]: manifest(hlsMaster, first) } });
    await manager.handleCandidate(candidate(first));
    await manager.handleCandidate(candidate(second, { timestamp: 2_000 }));
    await manager.idle();
    const streams = await manager.getStreams(1);
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({ url: second, lastSeen: 2_000 });
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('keeps the real request context once the page sends one', async () => {
    const { manager } = setup({ outcomes: { [MASTER]: manifest(hlsMaster, MASTER) } });
    await manager.handleCandidate(candidate(MASTER));
    await manager.handleCandidate(candidate(MASTER, { requestContext: { referer: 'https://site.example/watch' } }));
    await manager.handleCandidate(candidate(MASTER, { requestContext: {} }));
    await manager.idle();
    expect((await manager.getStreams(1))[0]?.requestContext).toEqual({ referer: 'https://site.example/watch' });
  });

  it('drops URLs whose body turns out not to be a manifest', async () => {
    const url = 'https://a.example/login.m3u8';
    const { manager, area } = setup({ outcomes: { [url]: { kind: 'not-manifest', reason: 'HTML' } } });
    await manager.handleCandidate(candidate(url));
    await manager.idle();
    expect(await manager.getStreams(1)).toEqual([]);
    expect(area.data.has(detectionStorageKey(1))).toBe(false);
  });

  it('marks expired links as errors and recovers when the page requests a re-signed URL', async () => {
    const expired = `${MASTER}?token=old`;
    const renewed = `${MASTER}?token=new`;
    const { manager, advance } = setup({
      outcomes: {
        [expired]: { kind: 'failed', reason: 'Access denied (HTTP 403).' },
        [renewed]: manifest(hlsMaster, renewed),
      },
    });
    await manager.handleCandidate(candidate(expired));
    await manager.idle();
    expect((await manager.getStreams(1))[0]).toMatchObject({ status: 'error', statusMessage: 'Access denied (HTTP 403).' });

    advance(10_000);
    await manager.handleCandidate(candidate(renewed));
    await manager.idle();
    const [stream] = await manager.getStreams(1);
    expect(stream).toMatchObject({ status: 'ready', url: renewed });
    expect(stream?.statusMessage).toBeUndefined();
  });

  it('does not hammer a failing server when the same URL is requested again', async () => {
    const { manager, inspect } = setup({ outcomes: { [MASTER]: { kind: 'failed', reason: 'HTTP 500' } } });
    await manager.handleCandidate(candidate(MASTER));
    await manager.idle();
    await manager.handleCandidate(candidate(MASTER));
    await manager.idle();
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('reports DRM-protected streams as unsupported', async () => {
    const url = 'https://drm.example.com/movie.mpd';
    const { manager } = setup({ outcomes: { [url]: manifest(dashDrm, url) } });
    await manager.handleCandidate(candidate(url));
    await manager.idle();
    expect((await manager.getStreams(1))[0]).toMatchObject({
      status: 'drm',
      statusMessage: 'Protected by Widevine / PlayReady DRM. DRM-protected streams are not supported.',
      manifest: { drmSystems: ['widevine', 'playready'], encryption: 'cenc' },
    });
  });

  describe('content probes (extensionless URLs with a generic Content-Type)', () => {
    const probe = (url: string): DetectionCandidate => {
      const { match: _match, ...rest } = candidate(url);
      return rest;
    };

    it('lists a probed URL only when its body is a manifest', async () => {
      const yes = 'https://api.example.com/video/7/playlist';
      const no = 'https://api.example.com/hls/segment-1';
      const { manager } = setup({
        outcomes: { [yes]: manifest(hlsMaster, yes), [no]: { kind: 'not-manifest', reason: 'binary' } },
      });
      await manager.handleCandidate(probe(yes));
      await manager.handleCandidate(probe(no));
      await manager.idle();
      expect(await manager.getStreams(1)).toMatchObject([{ url: yes, evidence: ['content'], status: 'ready' }]);
    });

    it('probes one URL shape once, so the segments of a stream are not all fetched', async () => {
      const { manager, inspect } = setup();
      for (let i = 1; i <= 20; i++) await manager.handleCandidate(probe(`https://api.example.com/hls/720/seg-${i}`));
      await manager.idle();
      expect(inspect).toHaveBeenCalledTimes(1);
    });

    it('probes other manifests of the same shape after a positive result', async () => {
      const a = 'https://api.example.com/video/1/playlist';
      const b = 'https://api.example.com/video/2/playlist';
      const { manager } = setup({ outcomes: { [a]: manifest(hlsTs, a), [b]: manifest(hlsTs, b) } });
      await manager.handleCandidate(probe(a));
      await manager.idle();
      await manager.handleCandidate(probe(b));
      await manager.idle();
      expect(await manager.getStreams(1)).toHaveLength(2);
    });

    it('caps probes per page', async () => {
      const { manager, inspect } = setup({ limits: { maxProbesPerPage: 2 } });
      for (const path of ['a', 'b', 'c', 'd']) await manager.handleCandidate(probe(`https://x.example/${path}/manifest`));
      await manager.idle();
      expect(inspect).toHaveBeenCalledTimes(2);
    });
  });

  it('discards results of work started before a navigation', async () => {
    const pending = deferred<InspectionOutcome>();
    const { manager, area } = setup({ outcomes: { [MASTER]: () => pending.promise } });
    await manager.handleCandidate(candidate(MASTER));
    await manager.resetTab(1, 'https://site.example/next-page');
    pending.resolve(manifest(hlsMaster, MASTER));
    await manager.idle();
    expect(await manager.getStreams(1)).toEqual([]);
    expect(area.data.has(detectionStorageKey(1))).toBe(false);
  });

  it('keeps tabs independent', async () => {
    const { manager } = setup({ outcomes: { [MASTER]: manifest(hlsMaster, MASTER) } });
    await manager.handleCandidate(candidate(MASTER, { tabId: 1 }));
    await manager.handleCandidate(candidate(MASTER, { tabId: 2 }));
    await manager.resetTab(1);
    await manager.idle();
    expect(await manager.getStreams(1)).toHaveLength(0);
    expect(await manager.getStreams(2)).toHaveLength(1);
  });

  it('keeps removed streams hidden until the tab navigates', async () => {
    const { manager } = setup({ outcomes: { [MASTER]: manifest(hlsMaster, MASTER) } });
    await manager.handleCandidate(candidate(MASTER));
    await manager.idle();
    const [stream] = await manager.getStreams(1);
    await expect(manager.removeStream(1, stream?.id ?? '')).resolves.toBe(true);
    await manager.handleCandidate(candidate(`${MASTER}?token=refresh`));
    await manager.idle();
    expect(await manager.getStreams(1)).toEqual([]);

    await manager.resetTab(1, 'https://site.example/again');
    await manager.handleCandidate(candidate(MASTER));
    await manager.idle();
    expect(await manager.getStreams(1)).toHaveLength(1);
    await expect(manager.removeStream(1, 'unknown')).resolves.toBe(false);
  });

  it('clears a tab on request and forgets closed tabs', async () => {
    const { manager, area } = setup({ outcomes: { [MASTER]: manifest(hlsMaster, MASTER) } });
    await manager.handleCandidate(candidate(MASTER, { tabId: 1 }));
    await manager.handleCandidate(candidate(MASTER, { tabId: 2 }));
    await manager.idle();
    await manager.clearTab(1);
    await manager.dropTab(2);
    await manager.idle();
    expect(await manager.getStreams(1)).toEqual([]);
    expect(area.data.has(detectionStorageKey(1))).toBe(false);
    expect(area.data.has(detectionStorageKey(2))).toBe(false);
  });

  it('survives a service-worker restart and finishes interrupted inspections', async () => {
    const area = new FakeStorageArea('session');
    const first = setup({ area, outcomes: { [MASTER]: () => new Promise<InspectionOutcome>(() => undefined) } });
    await first.manager.handleCandidate(candidate(MASTER, { requestContext: { referer: 'https://site.example/' } }));
    await vi.waitFor(() => {
      expect(area.data.has(detectionStorageKey(1))).toBe(true);
    });

    // A new worker instance: fresh manager, same session storage.
    const second = setup({ area, outcomes: { [MASTER]: manifest(hlsMaster, MASTER) } });
    expect(await second.manager.getStreams(1)).toMatchObject([{ url: MASTER }]);
    await second.manager.idle();
    expect(second.inspect).toHaveBeenCalledWith(MASTER, { referer: 'https://site.example/' });
    expect((await second.manager.getStreams(1))[0]?.status).toBe('ready');
  });

  it('applies titles and page information', async () => {
    const { manager, resolvePageInfo } = setup({
      outcomes: { [MASTER]: manifest(hlsMaster, MASTER) },
      pageInfo: { title: 'Big Buck Bunny', pageTitle: 'Movies', pageUrl: 'https://site.example/watch', durationHint: 596 },
    });
    await manager.handleCandidate(candidate(MASTER, { frameId: 5 }));
    await manager.idle();
    expect(resolvePageInfo).toHaveBeenCalledWith(1, 5);
    expect((await manager.getStreams(1))[0]).toMatchObject({
      title: 'Big Buck Bunny',
      pageTitle: 'Movies',
      pageUrl: 'https://site.example/watch',
      durationHint: 596,
    });
  });

  it('evicts the least recently seen stream when a tab reaches its limit', async () => {
    const { manager } = setup({ limits: { maxStreamsPerTab: 2 } });
    await manager.handleCandidate(candidate('https://a.example/1.m3u8', { timestamp: 1 }));
    await manager.handleCandidate(candidate('https://a.example/2.m3u8', { timestamp: 2 }));
    await manager.handleCandidate(candidate('https://a.example/1.m3u8', { timestamp: 3 }));
    await manager.handleCandidate(candidate('https://a.example/3.m3u8', { timestamp: 4 }));
    await manager.idle();
    expect((await manager.getStreams(1)).map((s) => s.url).sort()).toEqual([
      'https://a.example/1.m3u8',
      'https://a.example/3.m3u8',
    ]);
  });
});
