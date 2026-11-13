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
import type { SubtitleFileInspection } from '@/core/detection/subtitle-inspector';
import { PROGRESSIVE_VARIANT_ID, type ProgressiveInfo, type RequestContext } from '@/core/models/detected-stream';
import dashDrm from '@tests/fixtures/manifests/dash/drm.mpd?raw';
import dashDynamic from '@tests/fixtures/manifests/dash/dynamic.mpd?raw';
import dashStatic from '@tests/fixtures/manifests/dash/static-separate-av.mpd?raw';
import hlsMaster from '@tests/fixtures/manifests/hls/master.m3u8?raw';
import hlsMasterSubtitles from '@tests/fixtures/manifests/hls/master-subtitles.m3u8?raw';
import hlsLive from '@tests/fixtures/manifests/hls/media-live.m3u8?raw';
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
  options: {
    outcomes?: Outcomes;
    pageInfo?: PageInfo;
    limits?: Partial<DetectionLimits>;
    area?: FakeStorageArea;
    concurrency?: number;
    subtitleFiles?: Record<string, SubtitleFileInspection>;
  } = {},
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
  const inspectSubtitle = vi.fn(
    (url: string): Promise<SubtitleFileInspection> => Promise.resolve(options.subtitleFiles?.[url] ?? { ok: false, reason: 'no fixture' }),
  );
  const badge = new Map<number, number>();
  const manager = new DetectionManager({
    store: new SessionDetectionStore(area),
    inspect,
    inspectSubtitle,
    resolvePageInfo,
    onTabChanged: (tabId, streams) => badge.set(tabId, streams.length),
    now: () => clock,
    flushDelayMs: 0,
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.concurrency !== undefined ? { inspectionConcurrency: options.concurrency } : {}),
  });
  return {
    manager,
    area,
    inspect,
    inspectSubtitle,
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
    expect(second.inspect).toHaveBeenCalledWith(MASTER, { referer: 'https://site.example/' }, 'manifest');
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

describe('DetectionManager: progressive files (0.3.0)', () => {
  const FILE = 'https://media.example.net/v/clip.mp4?Expires=1&Signature=a';
  const CONTEXT = { referer: 'https://site.example/watch/1', origin: 'https://site.example' };

  function fileCandidate(url: string, overrides: Partial<DetectionCandidate> = {}): DetectionCandidate {
    return candidate(url, {
      match: { protocol: 'progressive', evidence: 'content-type' },
      progressive: { container: 'mp4', mimeType: 'video/mp4' },
      ...overrides,
    });
  }

  function fileOutcome(finalUrl: string, info: Partial<ProgressiveInfo> = {}): InspectionOutcome {
    return {
      kind: 'progressive',
      finalUrl,
      info: { container: 'mp4', mimeType: 'video/mp4', bytes: 734_003_200, acceptsRanges: true, fileName: 'clip.mp4', ...info },
    };
  }

  it('lists a file as pending with its container, then ready with what inspecting it revealed', async () => {
    const pending = deferred<InspectionOutcome>();
    const { manager, inspect, area } = setup({ outcomes: { [FILE]: () => pending.promise } });
    await manager.handleCandidate(fileCandidate(FILE, { requestContext: CONTEXT }));
    expect(await manager.getStreams(1)).toMatchObject([
      { url: FILE, protocol: 'progressive', status: 'pending', progressive: { container: 'mp4', mimeType: 'video/mp4' } },
    ]);
    expect(inspect).toHaveBeenCalledWith(FILE, CONTEXT, 'progressive');

    pending.resolve(fileOutcome(FILE));
    await manager.idle();
    const [stream] = await manager.getStreams(1);
    expect(stream).toMatchObject({
      status: 'ready',
      requestContext: CONTEXT,
      progressive: { container: 'mp4', mimeType: 'video/mp4', bytes: 734_003_200, acceptsRanges: true, fileName: 'clip.mp4' },
      // One "quality": the file itself, so the Detected tab's selection works unchanged.
      media: { variants: [{ id: PROGRESSIVE_VARIANT_ID, audioOnly: false, audioTrackIds: [] }], audioTracks: [] },
    });
    expect(stream?.manifest).toBeUndefined();
    expect(area.data.get(detectionStorageKey(1))).toMatchObject({ streams: [{ protocol: 'progressive', progressive: { bytes: 734_003_200 } }] });
  });

  it('lists one entry per file, however often and by whom it is requested', async () => {
    const { manager, inspect } = setup({ outcomes: { [FILE]: fileOutcome(FILE) } });
    // The element in the DOM, then its network requests (range after range, re-signed link).
    await manager.handleCandidate(
      fileCandidate(FILE, { match: { protocol: 'progressive', evidence: 'dom' }, progressive: { container: 'mp4' }, title: 'Trailer' }),
    );
    await manager.handleCandidate(fileCandidate(FILE, { requestContext: CONTEXT, timestamp: 2_000 }));
    const resigned = 'https://media.example.net/v/clip.mp4?Expires=2&Signature=b';
    await manager.handleCandidate(fileCandidate(resigned, { requestContext: CONTEXT, timestamp: 3_000 }));
    await manager.idle();
    const streams = await manager.getStreams(1);
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({ url: resigned, title: 'Trailer', evidence: ['dom', 'content-type'], requestContext: CONTEXT, status: 'ready' });
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('drops segments of a stream and skips further segments of the same shape until the next page', async () => {
    const segment = (n: number) => `https://cdn.example/hls/v1/seg-${n}.mp4`;
    const notFile: InspectionOutcome = { kind: 'not-manifest', reason: 'A segment of a stream, not a whole video file.' };
    const { manager, inspect } = setup({ outcomes: { [segment(1)]: notFile, [segment(9)]: notFile } });
    await manager.handleCandidate(fileCandidate(segment(1)));
    await manager.idle();
    await manager.handleCandidate(fileCandidate(segment(2)));
    await manager.handleCandidate(fileCandidate(segment(3)));
    await manager.idle();
    expect(await manager.getStreams(1)).toEqual([]);
    expect(inspect).toHaveBeenCalledTimes(1);

    await manager.resetTab(1, 'https://site.example/other');
    await manager.handleCandidate(fileCandidate(segment(9)));
    await manager.idle();
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("takes the element's own title when the DOM reports it after the element's request", async () => {
    const { manager } = setup({ outcomes: { [FILE]: fileOutcome(FILE) }, pageInfo: { title: 'Site name', pageTitle: 'Site name' } });
    // A media element loads its file at once; the content script's DOM scan reports it later.
    await manager.handleCandidate(fileCandidate(FILE, { requestContext: CONTEXT }));
    await manager.idle();
    expect((await manager.getStreams(1))[0]?.title).toBe('Site name');
    await manager.handleCandidate(fileCandidate(FILE, { match: { protocol: 'progressive', evidence: 'dom' }, title: 'Trailer' }));
    await manager.idle();
    expect((await manager.getStreams(1))[0]).toMatchObject({ title: 'Trailer', requestContext: CONTEXT, evidence: ['content-type', 'dom'] });
  });

  it('folds a redirecting link and its target into one entry, whichever is seen first', async () => {
    const link = 'https://site.example/play/7.mp4';
    const target = 'https://edge.cdn.example/store/f3a9/7.mp4?sig=xyz';
    const outcomes = { [link]: fileOutcome(target), [target]: fileOutcome(target) };
    const dom = { match: { protocol: 'progressive', evidence: 'dom' } } as const;

    const linkFirst = setup({ outcomes });
    await linkFirst.manager.handleCandidate(fileCandidate(link, dom));
    await linkFirst.manager.idle();
    await linkFirst.manager.handleCandidate(fileCandidate(target, { requestContext: CONTEXT }));
    await linkFirst.manager.idle();
    expect(await linkFirst.manager.getStreams(1)).toMatchObject([{ url: link, status: 'ready' }]);

    const targetFirst = setup({ outcomes });
    await targetFirst.manager.handleCandidate(fileCandidate(target, { requestContext: CONTEXT }));
    await targetFirst.manager.idle();
    await targetFirst.manager.handleCandidate(fileCandidate(link, dom));
    await targetFirst.manager.idle();
    expect(await targetFirst.manager.getStreams(1)).toMatchObject([{ url: link, status: 'ready' }]);
  });

  it('marks files that cannot be read as unavailable and retries once the page sends a new link', async () => {
    const expired = 'https://media.example.net/v/clip.mp4?Expires=1&Signature=old';
    const renewed = 'https://media.example.net/v/clip.mp4?Expires=2&Signature=new';
    const { manager, advance } = setup({
      outcomes: {
        [expired]: { kind: 'failed', reason: 'Access denied (HTTP 403). The link may have expired.' },
        [renewed]: fileOutcome(renewed),
      },
    });
    await manager.handleCandidate(fileCandidate(expired));
    await manager.idle();
    expect((await manager.getStreams(1))[0]).toMatchObject({
      status: 'error',
      statusMessage: expect.stringContaining('HTTP 403') as string,
      progressive: { container: 'mp4' },
    });
    advance(10_000);
    await manager.handleCandidate(fileCandidate(renewed));
    await manager.idle();
    expect((await manager.getStreams(1))[0]).toMatchObject({ status: 'ready', url: renewed });
  });

  it('ignores progressive candidates that carry no container', async () => {
    const { manager, inspect } = setup();
    const { progressive: _progressive, ...bare } = fileCandidate(FILE);
    await manager.handleCandidate(bare);
    await manager.idle();
    expect(await manager.getStreams(1)).toEqual([]);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('keeps files across a service-worker restart, next to manifests', async () => {
    const area = new FakeStorageArea('session');
    const first = setup({ area, outcomes: { [FILE]: fileOutcome(FILE), [MASTER]: manifest(hlsMaster, MASTER) } });
    await first.manager.handleCandidate(candidate(MASTER));
    await first.manager.handleCandidate(fileCandidate(FILE, { requestContext: CONTEXT }));
    await first.manager.idle();

    const second = setup({ area });
    const streams = await second.manager.getStreams(1);
    expect(streams.map((stream) => stream.protocol)).toEqual(['hls', 'progressive']);
    expect(streams[1]).toMatchObject({ status: 'ready', requestContext: CONTEXT, progressive: { container: 'mp4', bytes: 734_003_200 } });
    expect(second.inspect).not.toHaveBeenCalled();
  });
});

describe('DetectionManager: live streams (0.4.0)', () => {
  const LIVE = 'https://live.example.com/hls/123/index.m3u8';
  const reload = (n: number) => `${LIVE}?_HLS_msn=${2680 + n}&_HLS_part=${n % 3}&t=${n}`;
  /** A master as the adapter reports it in production: `live` comes from its first variant. */
  const liveMaster = (url: string): InspectionOutcome => {
    const outcome = manifest(hlsMaster, url);
    if (outcome.kind !== 'manifest') throw new Error('not a manifest');
    return { ...outcome, info: { ...outcome.info, live: true } };
  };

  it('never lists a live playlist and fetches it once, however often the player reloads it', async () => {
    const outcomes: Outcomes = {};
    for (let n = 0; n <= 50; n++) outcomes[reload(n)] = manifest(hlsLive, reload(n));
    const { manager, inspect, badge } = setup({ outcomes });
    for (let n = 0; n <= 50; n++) {
      await manager.handleCandidate(candidate(reload(n), { timestamp: 1_000 + n }));
      await manager.idle();
    }
    expect(await manager.getStreams(1)).toEqual([]);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(badge.get(1) ?? 0).toBe(0);
  });

  it('does not fetch the reloads that were waiting for an inspection slot once the first says live', async () => {
    const first = deferred<InspectionOutcome>();
    const outcomes: Outcomes = { [reload(0)]: () => first.promise };
    for (let n = 1; n <= 5; n++) outcomes[reload(n)] = manifest(hlsLive, reload(n));
    const { manager, inspect } = setup({ outcomes, concurrency: 1 });
    for (let n = 0; n <= 5; n++) await manager.handleCandidate(candidate(reload(n), { timestamp: 1_000 + n }));
    expect(await manager.getStreams(1)).toHaveLength(6); // pending: the first inspection has not answered yet
    first.resolve(manifest(hlsLive, reload(0)));
    await manager.idle();
    expect(await manager.getStreams(1)).toEqual([]);
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('ignores a dynamic (live) DASH manifest reloaded with a changing query', async () => {
    const mpd = 'https://live.example.com/dash/channel.mpd';
    const outcomes: Outcomes = { [`${mpd}?t=1`]: manifest(dashDynamic, `${mpd}?t=1`), [`${mpd}?t=2`]: manifest(dashDynamic, `${mpd}?t=2`) };
    const { manager, inspect } = setup({ outcomes });
    await manager.handleCandidate(candidate(`${mpd}?t=1`));
    await manager.idle();
    await manager.handleCandidate(candidate(`${mpd}?t=2`));
    await manager.idle();
    expect(await manager.getStreams(1)).toEqual([]);
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it("drops a live master's playlists loaded before it was inspected and skips those loaded after", async () => {
    const masterInspection = deferred<InspectionOutcome>();
    const variantInspection = deferred<InspectionOutcome>();
    const { manager, inspect } = setup({
      outcomes: { [MASTER]: () => masterInspection.promise, [VARIANTS[0] ?? '']: () => variantInspection.promise },
    });
    await manager.handleCandidate(candidate(MASTER));
    await manager.handleCandidate(candidate(VARIANTS[0] ?? ''));
    expect(await manager.getStreams(1)).toHaveLength(2);

    masterInspection.resolve(liveMaster(MASTER));
    variantInspection.resolve(manifest(hlsLive, VARIANTS[0] ?? ''));
    await manager.idle();
    expect(await manager.getStreams(1)).toEqual([]);

    // Reloads of the variants with fresh tokens: not fetched.
    await manager.handleCandidate(candidate(`${VARIANTS[1] ?? ''}&_HLS_msn=9`));
    await manager.handleCandidate(candidate(`${VARIANTS[2] ?? ''}?_HLS_msn=9`));
    await manager.idle();
    expect(await manager.getStreams(1)).toEqual([]);
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('still detects and keeps the VODs of a page that also plays a live, through 120 live reloads', async () => {
    const before = 'https://live.example.com/hls/456/index.m3u8';
    const after = 'https://live.example.com/hls/789/index.m3u8?token=a1';
    const outcomes: Outcomes = { [before]: manifest(hlsTs, before), [after]: manifest(hlsTs, after) };
    for (let n = 0; n < 120; n++) outcomes[reload(n)] = manifest(hlsLive, reload(n));
    const { manager, inspect, badge } = setup({ outcomes });

    await manager.handleCandidate(candidate(before, { timestamp: 1 }));
    await manager.idle();
    for (let n = 0; n < 120; n++) {
      await manager.handleCandidate(candidate(reload(n), { timestamp: 10 + n }));
      await manager.idle();
    }
    await manager.handleCandidate(candidate(after, { timestamp: 500 }));
    await manager.idle();
    // The first VOD is requested again with a re-signed link: still the same entry, with the fresh URL.
    await manager.handleCandidate(candidate(`${before}?expires=99`, { timestamp: 600 }));
    await manager.idle();

    const streams = await manager.getStreams(1);
    expect(streams.map((stream) => [stream.url, stream.status, stream.manifest?.live])).toEqual([
      [`${before}?expires=99`, 'ready', false],
      [after, 'ready', false],
    ]);
    expect(inspect).toHaveBeenCalledTimes(3);
    expect(badge.get(1)).toBe(2);
    expect(await manager.getStream(1, streams[0]?.id ?? '')).toMatchObject({ status: 'ready' });
  });

  it('does not list a live found by a content probe, nor probe its reloads', async () => {
    const url = 'https://api.example.com/live/7/playlist';
    const probe = (query: string): DetectionCandidate => {
      const { match: _match, ...rest } = candidate(`${url}${query}`);
      return rest;
    };
    const { manager, inspect } = setup({ outcomes: { [`${url}?n=1`]: manifest(hlsLive, `${url}?n=1`) } });
    await manager.handleCandidate(probe('?n=1'));
    await manager.idle();
    await manager.handleCandidate(probe('?n=2'));
    await manager.idle();
    expect(await manager.getStreams(1)).toEqual([]);
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('looks at the live again after a navigation (it may be a VOD by then), still without listing it', async () => {
    const { manager, inspect } = setup({ outcomes: { [reload(0)]: manifest(hlsLive, reload(0)), [reload(1)]: manifest(hlsLive, reload(1)) } });
    await manager.handleCandidate(candidate(reload(0)));
    await manager.idle();
    await manager.resetTab(1, 'https://live.example.com/watch');
    await manager.handleCandidate(candidate(reload(1)));
    await manager.idle();
    expect(await manager.getStreams(1)).toEqual([]);
    expect(inspect).toHaveBeenCalledTimes(2);
  });
});

describe('DetectionManager: <track> subtitles of progressive files (0.7.0)', () => {
  const FILE = 'https://media.example.net/v/clip.mp4';
  const outcome: InspectionOutcome = { kind: 'progressive', finalUrl: FILE, info: { container: 'mp4', mimeType: 'video/mp4' } };
  const EN = { id: 'track-0', name: 'English', language: 'en', isDefault: true, url: 'https://media.example.net/v/en.vtt' };
  const FR = { id: 'track-1', name: 'fr', language: 'fr', isDefault: false, url: 'https://media.example.net/v/fr.vtt' };
  const domCandidate = (subtitles?: NonNullable<DetectionCandidate['subtitles']>) =>
    candidate(FILE, { match: { protocol: 'progressive', evidence: 'dom' }, progressive: { container: 'mp4' }, ...(subtitles ? { subtitles } : {}) });

  it('lists the tracks reported before the file was inspected, and those added later', async () => {
    const { manager, area } = setup({ outcomes: { [FILE]: outcome } });
    await manager.handleCandidate(domCandidate([EN]));
    await manager.idle();
    let [stream] = await manager.getStreams(1);
    expect(stream?.media).toEqual({
      variants: [{ id: PROGRESSIVE_VARIANT_ID, audioOnly: false, audioTrackIds: [], subtitleTrackIds: ['track-0'] }],
      audioTracks: [],
      subtitleTracks: [EN],
    });

    await manager.handleCandidate(domCandidate([EN, FR]));
    await manager.idle();
    [stream] = await manager.getStreams(1);
    expect(stream?.media?.subtitleTracks).toEqual([EN, FR]);
    expect(stream?.media?.variants[0]?.subtitleTrackIds).toEqual(['track-0', 'track-1']);
    // Persisted with the stream.
    expect(area.data.get(detectionStorageKey(1))).toMatchObject({ streams: [{ media: { subtitleTracks: [EN, FR] } }] });
  });

  it('drops tracks the player removed, and keeps tracks of a file inspected only after a restart', async () => {
    const { manager } = setup({ outcomes: { [FILE]: outcome } });
    await manager.handleCandidate(domCandidate([EN]));
    await manager.idle();
    await manager.handleCandidate(domCandidate([]));
    await manager.idle();
    const [stream] = await manager.getStreams(1);
    expect(stream?.media?.subtitleTracks).toBeUndefined();
    expect(stream?.media?.variants[0]?.subtitleTrackIds).toBeUndefined();
    expect(stream?.domSubtitles).toBeUndefined();
  });

  it('keeps the reported tracks with a stored stream whose inspection failed (restart-safe)', async () => {
    const { manager, area } = setup({ outcomes: { [FILE]: { kind: 'failed', reason: 'HTTP 500' } } });
    await manager.handleCandidate(domCandidate([EN]));
    await manager.idle();
    expect(area.data.get(detectionStorageKey(1))).toMatchObject({ streams: [{ status: 'error', domSubtitles: [EN] }] });
  });

  it('does not let a DOM report replace the Referer seen on the network', async () => {
    const { manager } = setup({ outcomes: { [FILE]: outcome } });
    const network = { referer: 'https://site.example/watch/1' };
    await manager.handleCandidate(candidate(FILE, { match: { protocol: 'progressive', evidence: 'content-type' }, progressive: { container: 'mp4' }, requestContext: network }));
    await manager.handleCandidate({ ...domCandidate([EN]), requestContext: { referer: 'https://site.example/' } });
    await manager.idle();
    const [stream] = await manager.getStreams(1);
    expect(stream?.requestContext).toEqual(network);
    expect(stream?.media?.subtitleTracks).toEqual([EN]);
  });

  it('keeps a file without tracks free of subtitle fields', async () => {
    const { manager } = setup({ outcomes: { [FILE]: outcome } });
    await manager.handleCandidate(domCandidate());
    await manager.idle();
    const [stream] = await manager.getStreams(1);
    expect(stream?.media).toEqual({ variants: [{ id: PROGRESSIVE_VARIANT_ID, audioOnly: false, audioTrackIds: [] }], audioTracks: [] });
  });
});

describe('DetectionManager: page subtitle files (0.7.2)', () => {
  const MEDIA = 'https://cdn.example.com/vod/movie/720p.m3u8';
  const ZH = 'https://cdn.example.com/sub/captions.zh.vtt.r20240612';
  const EN = 'https://cdn.example.com/sub/movie.en.vtt';
  const SEGMENT = 'https://cdn.example.com/sub/seg_0001.vtt';
  const files: Record<string, SubtitleFileInspection> = {
    [ZH]: { ok: true, language: 'zh' },
    [EN]: { ok: true, language: 'en' },
    [SEGMENT]: { ok: false, reason: 'A segment of a subtitle rendition, not a whole file' },
  };
  const subtitleFile = (url: string, frameId = 0) => ({ tabId: 1, frameId, url, requestContext: { referer: 'https://site.example/' }, timestamp: 1_000 });
  const ZH_TRACK = { id: 'page-0', name: 'Chinese', language: 'zh', isDefault: false, url: ZH };

  it('offers a checked file with every quality of an HLS stream, found before or after the stream', async () => {
    const { manager, area, inspectSubtitle } = setup({ outcomes: { [MEDIA]: manifest(hlsTs, MEDIA) }, subtitleFiles: files });
    await manager.handleSubtitleFile(subtitleFile(ZH));
    await manager.handleCandidate(candidate(MEDIA));
    await manager.idle();
    let [stream] = await manager.getStreams(1);
    expect(stream?.media?.subtitleTracks).toEqual([ZH_TRACK]);
    expect(stream?.media?.variants.every((variant) => variant.subtitleTrackIds?.join() === 'page-0')).toBe(true);

    // Segments of a rendition are rejected; the same file is checked once.
    await manager.handleSubtitleFile(subtitleFile(SEGMENT));
    await manager.handleSubtitleFile(subtitleFile(ZH));
    await manager.handleSubtitleFile(subtitleFile(EN));
    await manager.idle();
    expect(inspectSubtitle).toHaveBeenCalledTimes(3);
    [stream] = await manager.getStreams(1);
    expect(stream?.media?.subtitleTracks?.map((track) => [track.id, track.name])).toEqual([
      ['page-0', 'Chinese'],
      ['page-1', 'English'],
    ]);
    expect(area.data.get(detectionStorageKey(1))).toMatchObject({ subtitleFiles: [ZH_TRACK, { id: 'page-1', url: EN }] });
  });

  it('keeps the files across a restart and forgets them on navigation', async () => {
    const area = new FakeStorageArea('session');
    const first = setup({ area, subtitleFiles: files });
    await first.manager.handleSubtitleFile(subtitleFile(ZH));
    await first.manager.idle();

    const second = setup({ area, outcomes: { [MEDIA]: manifest(hlsTs, MEDIA) }, subtitleFiles: files });
    await second.manager.handleCandidate(candidate(MEDIA));
    await second.manager.handleSubtitleFile(subtitleFile(ZH));
    await second.manager.idle();
    expect(second.inspectSubtitle).not.toHaveBeenCalled();
    expect((await second.manager.getStreams(1))[0]?.media?.subtitleTracks).toEqual([ZH_TRACK]);

    await second.manager.resetTab(1, 'https://site.example/next');
    await second.manager.handleCandidate(candidate(MEDIA));
    await second.manager.idle();
    expect((await second.manager.getStreams(1))[0]?.media?.subtitleTracks).toBeUndefined();
  });

  it("lists a progressive file's <track> once, and the page's other files after its tracks", async () => {
    const FILE = 'https://cdn.example.com/v/clip.mp4';
    const TRACK = { id: 'track-0', name: 'English', language: 'en', isDefault: true, url: EN };
    const { manager } = setup({ outcomes: { [FILE]: { kind: 'progressive', finalUrl: FILE, info: { container: 'mp4' } } }, subtitleFiles: files });
    await manager.handleCandidate(
      candidate(FILE, { match: { protocol: 'progressive', evidence: 'dom' }, progressive: { container: 'mp4' }, subtitles: [TRACK] }),
    );
    await manager.handleSubtitleFile(subtitleFile(EN));
    await manager.handleSubtitleFile(subtitleFile(ZH));
    await manager.idle();
    const [stream] = await manager.getStreams(1);
    expect(stream?.media?.subtitleTracks?.map((track) => track.id)).toEqual(['track-0', 'page-1']);
    expect(stream?.media?.variants[0]?.subtitleTrackIds).toEqual(['track-0', 'page-1']);
  });

  it('keeps the newest files when full (a single-page site moving on), never reusing an id', async () => {
    const many = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`https://cdn.example.com/s${'abcde'[i]}/x.vtt`, { ok: true } as const]));
    const { manager } = setup({ outcomes: { [MEDIA]: manifest(hlsTs, MEDIA) }, subtitleFiles: many, limits: { maxSubtitleFilesPerTab: 2 } });
    await manager.handleCandidate(candidate(MEDIA));
    for (const url of Object.keys(many)) await manager.handleSubtitleFile(subtitleFile(url));
    await manager.idle();
    const [stream] = await manager.getStreams(1);
    expect(stream?.media?.subtitleTracks?.map((track) => track.id)).toEqual(['page-3', 'page-4']);
  });

  it('keeps the newest link of a file it already has', async () => {
    const { manager } = setup({ outcomes: { [MEDIA]: manifest(hlsTs, MEDIA) }, subtitleFiles: { [ZH]: files[ZH]!, [`${ZH}?token=2`]: files[ZH]! } });
    await manager.handleCandidate(candidate(MEDIA));
    await manager.handleSubtitleFile(subtitleFile(ZH));
    await manager.handleSubtitleFile(subtitleFile(`${ZH}?token=2`));
    await manager.idle();
    expect((await manager.getStreams(1))[0]?.media?.subtitleTracks).toEqual([{ ...ZH_TRACK, url: `${ZH}?token=2` }]);
  });

  it('keeps the files when the list is cleared, also one still being checked; a file that could not be fetched is checked again', async () => {
    const pending = deferred<SubtitleFileInspection>();
    let calls = 0;
    const custom = new DetectionManager({
      store: new SessionDetectionStore(new FakeStorageArea('session')),
      inspect: (url) => Promise.resolve(url === MEDIA ? manifest(hlsTs, MEDIA) : { kind: 'failed', reason: 'x' }),
      inspectSubtitle: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve({ ok: false, reason: 'HTTP 503', transient: true }) : pending.promise;
      },
      resolvePageInfo: () => Promise.resolve({}),
      flushDelayMs: 0,
    });
    await custom.handleSubtitleFile(subtitleFile(ZH)); // 503: forgotten
    const second = custom.handleSubtitleFile(subtitleFile(ZH)); // checked again, still running when the list is cleared
    await custom.clearTab(1);
    pending.resolve({ ok: true, language: 'zh' });
    await second;
    await custom.handleCandidate(candidate(MEDIA));
    await custom.idle();
    expect(calls).toBe(2);
    expect((await custom.getStreams(1))[0]?.media?.subtitleTracks).toEqual([ZH_TRACK]);
  });

  it('records how far the player moves the file’s cues, asking its frame and then the top frame', async () => {
    const fileCues = [
      { start: 10.086, text: '我會的' },
      { start: 27.266, text: '老公' },
    ];
    const shifted = [{ kind: 'metadata', cues: fileCues.map((cue) => ({ ...cue, start: cue.start + 4.56 })) }];
    const asked: number[] = [];
    let attempt = 0;
    const area = new FakeStorageArea('session');
    const manager = new DetectionManager({
      store: new SessionDetectionStore(area),
      inspect: (url) => Promise.resolve(url === MEDIA ? manifest(hlsTs, MEDIA) : { kind: 'failed', reason: 'x' }),
      inspectSubtitle: () => Promise.resolve({ ok: true, language: 'zh', cues: fileCues }),
      // The player adds its cues a little after loading the file: none on the first try, then in the top frame.
      readTextTracks: (_tabId, frameId) => {
        asked.push(frameId);
        if (frameId === 0) attempt += 1;
        return Promise.resolve(frameId === 0 && attempt >= 2 ? shifted : []);
      },
      cueCheckDelaysMs: [0, 0, 0],
      resolvePageInfo: () => Promise.resolve({}),
      flushDelayMs: 0,
    });
    await manager.handleCandidate(candidate(MEDIA));
    await manager.handleSubtitleFile(subtitleFile(ZH, 3));
    await vi.waitFor(async () => {
      expect((await manager.getStreams(1))[0]?.media?.subtitleTracks).toEqual([{ ...ZH_TRACK, offsetSec: 4.56 }]);
    });
    await manager.idle();
    expect(asked).toEqual([3, 0, 3, 0]);
    expect(area.data.get(detectionStorageKey(1))).toMatchObject({ subtitleFiles: [{ id: 'page-0', offsetSec: 4.56 }] });
  });

  it('does not offer again what the manifest already has: a file in its language, or its numbered segments', async () => {
    const EN_FILE = { ok: true, language: 'en' } as const;
    const SEG = (n: number) => `https://cdn.example.com/vod/movie/subs/en/seg-${n}.vtt`;
    const { manager } = setup({
      outcomes: { [MASTER]: manifest(hlsMasterSubtitles, MASTER) },
      subtitleFiles: { [EN]: EN_FILE, [ZH]: files[ZH]!, [SEG(1)]: { ok: true }, [SEG(2)]: { ok: true }, [SEG(3)]: { ok: true } },
    });
    await manager.handleCandidate(candidate(MASTER));
    await manager.idle();
    for (const url of [EN, ZH, SEG(1), SEG(2), SEG(3)]) await manager.handleSubtitleFile(subtitleFile(url));
    await manager.idle();
    const [stream] = await manager.getStreams(1);
    const own = stream?.media?.subtitleTracks?.filter((track) => !track.id.startsWith('page-')) ?? [];
    expect(own.some((track) => track.language === 'en')).toBe(true);
    // English is the manifest's own; the numbered files are a rendition's segments: only Chinese is added.
    expect(stream?.media?.subtitleTracks?.filter((track) => track.id.startsWith('page-')).map((track) => track.name)).toEqual(['Chinese']);
    expect(stream?.media?.subtitleTracks?.slice(0, own.length)).toEqual(own);
  });
});
