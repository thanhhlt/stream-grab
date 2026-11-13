import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { hexToBytes } from '@/core/download/aes';
import {
  DownloadManager,
  EXPIRED_LINK_MESSAGE,
  planSignature,
  VIDEO_CHANGED_MESSAGE,
  type DownloadManagerDeps,
} from '@/core/download/download-manager';
import { IndexedDbSegmentStorage, type SegmentStorage } from '@/core/download/download-storage';
import { SyncPartialFiles } from '@/core/download/partial-files';
import { estimateSize } from '@/core/download/estimate';
import { diskFullMessage } from '@/core/download/storage-space';
import type { MediaSegment } from '@/core/models/media-segment';
import type { RequestContext } from '@/core/models/detected-stream';
import type { EngineReport, EngineTaskSpec, SaveRequest } from '@/core/models/download-task';
import { ManifestFetcher } from '@/core/network/manifest-fetcher';
import { DashAdapter } from '@/core/protocols/dash/dash-adapter';
import { HlsAdapter } from '@/core/protocols/hls/hls-adapter';
import { ProtocolRegistry } from '@/core/protocols/protocol-adapter';
import { crashable, until } from '@tests/fakes/crash';
import { bodyFor, FakeMediaSite } from '@tests/fakes/media-site';
import { MemoryOutputFiles } from '@tests/fakes/output-files';
import { MOVIE_BASE as BASE, mediaPlaylist, movieSite, SEGMENT_SIZE } from '@tests/fakes/movie-site';
import dashDrm from '@tests/fixtures/manifests/dash/drm.mpd?raw';
import dashSegmentBase from '@tests/fixtures/manifests/dash/segment-base.mpd?raw';
import dashStatic from '@tests/fixtures/manifests/dash/static-separate-av.mpd?raw';
import dashSubtitles from '@tests/fixtures/manifests/dash/subtitles.mpd?raw';
import hlsLive from '@tests/fixtures/manifests/hls/media-live.m3u8?raw';
import hlsSampleAes from '@tests/fixtures/manifests/hls/media-sample-aes.m3u8?raw';

function spec(overrides: Partial<EngineTaskSpec> = {}): EngineTaskSpec {
  return {
    taskId: 't1',
    protocol: 'hls',
    manifestUrl: `${BASE}master.m3u8`,
    context: {},
    variant: { id: 'video-0', height: 720, bandwidth: 2000000 },
    audioTrackIds: ['audio-0'],
    concurrency: 3,
    ...overrides,
  };
}

function setup(site: FakeMediaSite, overrides: Partial<DownloadManagerDeps> = {}) {
  const storage: SegmentStorage = overrides.storage ?? new IndexedDbSegmentStorage(new IDBFactory());
  const reports: EngineReport[] = [];
  const released: string[] = [];
  const state: { fresh: { manifestUrl: string; context: RequestContext } | null } = { fresh: null };
  const manager = new DownloadManager({
    protocols: () => {
      const fetcher = new ManifestFetcher({ fetch: site.fetch });
      return new ProtocolRegistry().register(new HlsAdapter({ fetcher })).register(new DashAdapter({ fetcher }));
    },
    fetchFor: () => site.fetch,
    freshSource: () => Promise.resolve(state.fresh),
    releaseContexts: (taskId) => {
      released.push(taskId);
      return Promise.resolve();
    },
    report: (report) => reports.push(report),
    retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 4, maxRetryAfterMs: 4 },
    reportIntervalMs: 0,
    ...overrides,
    storage,
  });

  const outcome = (taskId = 't1') => reports.findLast((report) => report.taskId === taskId && report.outcome)?.outcome;
  const last = (taskId = 't1') => reports.filter((report) => report.taskId === taskId).at(-1);
  /** All stored bytes of one track, in output order. */
  const stored = async (trackId: string, taskId = 't1') => {
    const parts = await storage.listParts(taskId, trackId);
    const blobs = await Promise.all(parts.map((part) => storage.read(part)));
    return new Uint8Array(await new Blob(blobs.filter((blob) => blob !== undefined)).arrayBuffer());
  };
  const expected = (urls: string[], size = SEGMENT_SIZE) => {
    const out = new Uint8Array(urls.length * size);
    urls.forEach((url, i) => {
      out.set(bodyFor(url, size), i * size);
    });
    return out;
  };
  return { manager, storage, reports, released, state, outcome, last, stored, expected };
}

const urls = (path: string, count: number, query = '') =>
  Array.from({ length: count }, (_, i) => `${BASE}${path}/seg-${i}.ts${query}`);

describe('DownloadManager', () => {
  it('downloads the variant and its audio track, stored in playlist order whatever the completion order', async () => {
    const site = movieSite(10);
    // Later segments answer first, so completion order is the reverse of playlist order.
    site.latencyFor = (url) => {
      const match = /seg-(\d+)/.exec(url);
      return match ? 20 - Number(match[1]) : 0;
    };
    const { manager, outcome, last, stored, expected, released } = setup(site);
    expect(manager.sync([spec()])).toEqual(['t1']);
    await manager.idle();

    expect(outcome()).toEqual({ status: 'downloaded' });
    expect(await stored('main')).toEqual(expected(urls('v720', 10)));
    expect(await stored('audio-0')).toEqual(expected(urls('audio', 10)));
    expect(last()?.progress).toMatchObject({ segmentsTotal: 20, segmentsDone: 20, percent: 100, bytes: 20 * SEGMENT_SIZE });
    // Theo từng track, để popup ước lượng dung lượng của video và audio riêng rẽ.
    expect(last()?.progress.tracks).toEqual([
      { trackId: 'main', segmentsTotal: 10, segmentsDone: 10, bytes: 10 * SEGMENT_SIZE },
      { trackId: 'audio-0', segmentsTotal: 10, segmentsDone: 10, bytes: 10 * SEGMENT_SIZE },
    ]);
    expect(last()?.progress.averageBytesPerSecond).toBeGreaterThanOrEqual(0);
    expect(site.count(`${BASE}v360/seg-0.ts`)).toBe(0);
    expect(released).toEqual(['t1']);
  });

  it('keeps at most `concurrency` segment requests in flight', async () => {
    const site = movieSite(30);
    site.latencyFor = (url) => (url.includes('/seg-') ? 3 : 0);
    const { manager, outcome } = setup(site);
    manager.sync([spec({ concurrency: 4, audioTrackIds: [] })]);
    await manager.idle();
    expect(outcome()).toEqual({ status: 'downloaded' });
    expect(site.maxInFlight).toBe(4);
  });

  it('reports monotonic progress while downloading', async () => {
    const site = movieSite(12);
    const { manager, reports } = setup(site);
    manager.sync([spec({ audioTrackIds: [] })]);
    await manager.idle();
    const done = reports.map((report) => report.progress.segmentsDone);
    expect(done).toEqual([...done].sort((a, b) => a - b));
    expect(reports[0]?.progress).toMatchObject({ segmentsTotal: 12, segmentsDone: 0, percent: 0 });
  });

  describe('scenario: failed segment requests with retry', () => {
    it('retries with backoff and completes', async () => {
      const site = movieSite(5);
      const flaky = `${BASE}v720/seg-2.ts`;
      site.failNext(flaky, { status: 503 }, { status: 500 });
      const { manager, outcome, last, stored, expected } = setup(site);
      manager.sync([spec({ audioTrackIds: [] })]);
      await manager.idle();
      expect(outcome()).toEqual({ status: 'downloaded' });
      expect(site.count(flaky)).toBe(3);
      expect(last()?.progress.retries).toBe(2);
      expect(await stored('main')).toEqual(expected(urls('v720', 5)));
    });

    it('fails the task after the last attempt and keeps the completed segments for Retry', async () => {
      const site = movieSite(5);
      site.failNext(`${BASE}v720/seg-1.ts`, { status: 500 }, { status: 500 }, { status: 500 });
      const { manager, outcome, storage, last } = setup(site);
      manager.sync([spec({ audioTrackIds: [], concurrency: 1 })]);
      await manager.idle();
      expect(outcome()).toEqual({
        status: 'failed',
        message: 'Segment 2 of 5 failed after 3 attempts: Server error (HTTP 500)',
      });
      // One worker: seg-0 was complete when seg-1 gave up; nothing of seg-1 is marked complete.
      expect((await storage.inspectTask('t1')).complete.map((segment) => segment.index)).toEqual([0]);
      expect(last()?.progress).toMatchObject({ segmentsDone: 1, bytes: SEGMENT_SIZE });
    });

    it('retries a segment answered with an error page, and names the problem if it persists', async () => {
      const site = movieSite(4);
      const page = '<html><body>503 Service Temporarily Unavailable</body></html>';
      // An overload page once, then the segment; and a segment that is always a page.
      site.failNext(`${BASE}v720/seg-1.ts`, { status: 200, body: page, headers: { 'content-type': 'text/html' } });
      site.serve(`${BASE}v720/seg-2.ts`, page, 'text/html');
      const { manager, outcome, storage } = setup(site);
      manager.sync([spec({ audioTrackIds: [], concurrency: 1 })]);
      await manager.idle();
      expect(outcome()).toEqual({
        status: 'failed',
        message:
          'Segment 3 of 4 failed after 3 attempts: The server sent a web page instead of video data (HTTP 200). The link may have expired, or the site may want you signed in: play the video again on its page, then press Retry',
      });
      // The page never reached storage; the segment that recovered did.
      expect((await storage.inspectTask('t1')).complete.map((segment) => segment.index)).toEqual([0, 1]);
    });

    it('does not retry client errors that cannot succeed', async () => {
      const site = movieSite(3);
      site.failNext(`${BASE}v720/seg-0.ts`, { status: 400 });
      const { manager, outcome } = setup(site);
      manager.sync([spec({ audioTrackIds: [] })]);
      await manager.idle();
      expect(outcome()).toEqual({ status: 'failed', message: 'Segment 1 of 3: Request failed (HTTP 400)' });
      expect(site.count(`${BASE}v720/seg-0.ts`)).toBe(1);
    });
  });

  describe('scenario: expired manifest URLs', () => {
    it('refreshes from the freshest source and continues with the new links', async () => {
      const site = movieSite(6, 'new'); // only the re-signed links work
      // The old (expired) master still answers, but its segment links are dead.
      site.serve(`${BASE}master.m3u8?token=old`, (site.routes.get(`${BASE}master.m3u8?token=new`)?.body as string).replaceAll('token=new', 'token=old'));
      site.serve(`${BASE}v720/index.m3u8?token=old`, mediaPlaylist(6, '?token=old'));
      const { manager, outcome, state, stored, expected, released } = setup(site);
      state.fresh = { manifestUrl: `${BASE}master.m3u8?token=new`, context: { referer: 'https://site.example/watch' } };
      manager.sync([spec({ manifestUrl: `${BASE}master.m3u8?token=old`, audioTrackIds: [] })]);
      await manager.idle();
      expect(outcome()).toEqual({ status: 'downloaded' });
      expect(await stored('main')).toEqual(expected(urls('v720', 6, '?token=new')));
      expect(released.filter((id) => id === 't1').length).toBeGreaterThanOrEqual(2); // context changed, then task end
    });

    it('asks the user to replay the video when no fresh link exists', async () => {
      const site = movieSite(4);
      for (let i = 0; i < 4; i++) site.routes.delete(`${BASE}v720/seg-${i}.ts`);
      const { manager, outcome } = setup(site);
      manager.sync([spec({ audioTrackIds: [] })]);
      await manager.idle();
      expect(outcome()).toEqual({ status: 'failed', message: EXPIRED_LINK_MESSAGE, reason: 'expired' });
    });

    it('treats an expired manifest the same way', async () => {
      const { manager, outcome } = setup(new FakeMediaSite());
      manager.sync([spec()]);
      await manager.idle();
      expect(outcome()).toEqual({ status: 'failed', message: EXPIRED_LINK_MESSAGE, reason: 'expired' });
    });
  });

  describe('cancellation', () => {
    it('stops downloading, deletes stored segments and reports cancelled', async () => {
      const site = movieSite(40);
      site.latencyFor = (url) => (url.includes('/seg-') ? 10 : 0);
      const { manager, outcome, storage, reports } = setup(site);
      manager.sync([spec({ concurrency: 2, audioTrackIds: [] })]);
      while (!reports.some((report) => report.progress.segmentsDone >= 2)) await new Promise((r) => setTimeout(r, 5));
      const requestsAtCancel = site.requests.length;
      await manager.cancel(['t1']);
      // Resolved only once the task stopped and cleaned up: no idle() needed.
      expect(outcome()).toEqual({ status: 'cancelled' });
      expect(await storage.listParts('t1')).toEqual([]);
      expect(site.requests.length - requestsAtCancel).toBeLessThanOrEqual(2);
      expect(manager.running).toEqual([]);
    });

    it('runs exactly the synced tasks', async () => {
      const site = movieSite(30);
      site.latencyFor = (url) => (url.includes('/seg-') ? 5 : 0);
      const { manager, outcome } = setup(site);
      manager.sync([spec({ taskId: 'a' }), spec({ taskId: 'b' })]);
      expect(manager.sync([spec({ taskId: 'b' })])).toEqual(['b']);
      await manager.idle();
      expect(outcome('a')).toEqual({ status: 'cancelled' });
      expect(outcome('b')).toEqual({ status: 'downloaded' });
    });

    it('sends the outcome again to a sync built before it arrived, instead of downloading the task twice (0.9.0)', async () => {
      const site = movieSite(4);
      const { manager, outcome, reports, storage } = setup(site);
      manager.sync([spec({ audioTrackIds: [] })]);
      await manager.idle();
      expect(outcome()).toEqual({ status: 'downloaded' });
      const requests = site.requests.length;
      const outcomes = reports.filter((report) => report.outcome).length;

      // Stale: the service worker had not seen "downloaded" yet. Its next sync would have cancelled a
      // second run and deleted the segments the merge needs.
      expect(manager.sync([spec({ audioTrackIds: [] })])).toEqual([]);
      await manager.idle();
      expect(site.requests.length).toBe(requests);
      expect(reports.filter((report) => report.outcome).map((report) => report.outcome).slice(outcomes)).toEqual([{ status: 'downloaded' }]);
      manager.sync([]);
      await manager.idle();
      expect((await storage.inspectTask('t1')).complete).toHaveLength(4);

      // Listed again after a sync without it: a real new run (Retry).
      expect(manager.sync([spec({ audioTrackIds: [] })])).toEqual(['t1']);
      await manager.idle();
      expect(site.requests.length).toBeGreaterThan(requests);
    });

    it('starts a Retry (another run number) even when no sync came between the failure and it (0.9.0)', async () => {
      const site = movieSite(4);
      site.failNext(`${BASE}v720/seg-2.ts`, { status: 500 }, { status: 500 }, { status: 500 });
      const { manager, outcome } = setup(site);
      manager.sync([spec({ audioTrackIds: [], concurrency: 1, run: 1 })]);
      await manager.idle();
      expect(outcome()).toMatchObject({ status: 'failed' });
      // The failure is remembered for run 1 only: run 2 is downloaded, not failed again.
      expect(manager.sync([spec({ audioTrackIds: [], concurrency: 1, run: 2 })])).toEqual(['t1']);
      await manager.idle();
      expect(outcome()).toEqual({ status: 'downloaded' });
    });

    it('answers an emptying sync only after the stopped tasks deleted their data (the engine closes next)', async () => {
      const site = movieSite(40);
      site.latencyFor = (url) => (url.includes('/seg-') ? 10 : 0);
      const { manager, outcome, storage, reports } = setup(site);
      manager.sync([spec({ taskId: 'a', concurrency: 2, audioTrackIds: [] })]);
      while (!reports.some((report) => report.progress.segmentsDone >= 2)) await new Promise((r) => setTimeout(r, 5));
      await expect(manager.syncSettled([])).resolves.toEqual([]);
      expect(outcome('a')).toEqual({ status: 'cancelled' });
      expect(await storage.listParts('a')).toEqual([]);
      expect(manager.running).toEqual([]);
    });

    it('stops waiting for a task that does not finish cleaning up in time', async () => {
      const { manager } = setup(movieSite(5), { releaseContexts: () => new Promise(() => undefined), settleTimeoutMs: 20 });
      manager.sync([spec({ audioTrackIds: [] })]);
      const started = Date.now();
      await manager.cancel(['t1']);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(manager.running).toEqual(['t1']); // still stuck releasing its rules
    });
  });

  describe('resume (Phase 7)', () => {
    it('Retry fetches only the segments a failed run did not complete, and counts the others as done', async () => {
      const site = movieSite(6);
      site.failNext(`${BASE}v720/seg-3.ts`, { status: 500 }, { status: 500 }, { status: 500 });
      const { manager, reports, outcome, last, stored, expected } = setup(site);
      manager.sync([spec({ audioTrackIds: [], concurrency: 1 })]);
      await manager.idle();
      expect(outcome()).toMatchObject({ status: 'failed' });
      const firstRun = reports.length;

      manager.sync([]); // the service worker's next sync, once the outcome reached it
      manager.sync([spec({ audioTrackIds: [], concurrency: 1 })]);
      await manager.idle();
      expect(outcome()).toEqual({ status: 'downloaded' });
      for (const [i, count] of [1, 1, 1, 4, 1, 1].entries()) expect(site.count(`${BASE}v720/seg-${i}.ts`)).toBe(count);
      expect(await stored('main')).toEqual(expected(urls('v720', 6)));
      // The second run starts at 3 of 6, not at 0, and never reports the reused bytes as speed.
      expect(reports[firstRun]?.progress).toMatchObject({ segmentsDone: 3, segmentsTotal: 6, percent: 50, resumedSegments: 3, bytesPerSecond: 0 });
      expect(reports[firstRun]?.progress.tracks).toEqual([{ trackId: 'main', segmentsTotal: 6, segmentsDone: 3, bytes: 3 * SEGMENT_SIZE }]);
      expect(last()?.progress).toMatchObject({ segmentsDone: 6, bytes: 6 * SEGMENT_SIZE, resumedSegments: 3 });
    });

    it('a new engine resumes what a crashed one stored, and fetches interrupted writes again', async () => {
      const site = movieSite(12);
      site.latencyFor = (url) => (url.includes('/seg-') ? 2 : 0);
      const factory = new IDBFactory();
      const dying = crashable(new IndexedDbSegmentStorage(factory), site.fetch);
      const firstReports: EngineReport[] = [];
      const first = new DownloadManager({
        storage: dying.storage,
        protocols: () => {
          const fetcher = new ManifestFetcher({ fetch: dying.fetch });
          return new ProtocolRegistry().register(new HlsAdapter({ fetcher })).register(new DashAdapter({ fetcher }));
        },
        fetchFor: () => dying.fetch,
        freshSource: () => Promise.resolve(null),
        releaseContexts: () => Promise.resolve(),
        report: (report) => firstReports.push(report),
        reportIntervalMs: 0,
      });
      first.sync([spec({ audioTrackIds: [], concurrency: 2 })]);
      await until(() => firstReports.some((report) => report.progress.segmentsDone >= 5));
      dying.crash(); // the browser closed: no cleanup, no further writes

      const storage = new IndexedDbSegmentStorage(factory);
      // A write cut off halfway: a part, but no completion marker.
      await storage.put({ taskId: 't1', trackId: 'main', index: 11, part: 0 }, new Blob(['cut off']));
      const kept = (await storage.inspectTask('t1')).complete.map((segment) => segment.index);
      expect(kept.length).toBeGreaterThanOrEqual(5);
      const requested = new Map(urls('v720', 12).map((url) => [url, site.count(url)]));

      const { manager, reports, outcome, stored, expected } = setup(site, { storage });
      manager.sync([spec({ audioTrackIds: [], concurrency: 2 })]);
      await manager.idle();
      expect(outcome()).toEqual({ status: 'downloaded' });
      expect(await stored('main')).toEqual(expected(urls('v720', 12)));
      expect(reports[0]?.progress).toMatchObject({ segmentsDone: kept.length, resumedSegments: kept.length });
      for (const index of kept) {
        const url = `${BASE}v720/seg-${index}.ts`;
        expect(site.count(url)).toBe(requested.get(url)); // not downloaded again
      }
    });

    it('starts over when the stored segments belong to another version of the video', async () => {
      const site = movieSite(4);
      site.failNext(`${BASE}v720/seg-3.ts`, { status: 500 }, { status: 500 }, { status: 500 });
      const { manager, outcome, last, stored, expected, storage } = setup(site);
      manager.sync([spec({ audioTrackIds: [], concurrency: 1 })]);
      await manager.idle();
      expect((await storage.summary('t1'))?.segmentsDone).toBe(3);

      movieSite(5, '', site); // re-published with another segment list
      manager.sync([]); // the service worker's next sync, once the outcome reached it
      manager.sync([spec({ audioTrackIds: [], concurrency: 1 })]);
      await manager.idle();
      expect(outcome()).toEqual({ status: 'downloaded' });
      expect(site.count(`${BASE}v720/seg-0.ts`)).toBe(2);
      expect(await stored('main')).toEqual(expected(urls('v720', 5)));
      expect(last()?.progress.resumedSegments).toBeUndefined();
    });

    it('discards the stored segments when the video changes while it downloads', async () => {
      const site = movieSite(7, 'new');
      site.serve(`${BASE}master.m3u8?token=old`, (site.routes.get(`${BASE}master.m3u8?token=new`)?.body as string).replaceAll('token=new', 'token=old'));
      site.serve(`${BASE}v720/index.m3u8?token=old`, mediaPlaylist(6, '?token=old'));
      for (let i = 0; i < 3; i++) site.serve(`${BASE}v720/seg-${i}.ts?token=old`, bodyFor(`${BASE}v720/seg-${i}.ts`, SEGMENT_SIZE));
      const { manager, outcome, last, storage, state } = setup(site);
      state.fresh = { manifestUrl: `${BASE}master.m3u8?token=new`, context: {} };
      manager.sync([spec({ manifestUrl: `${BASE}master.m3u8?token=old`, audioTrackIds: [], concurrency: 1 })]);
      await manager.idle();
      expect(outcome()).toEqual({ status: 'failed', message: VIDEO_CHANGED_MESSAGE });
      expect(await storage.taskIds()).toEqual([]);
      expect(last()?.progress).toMatchObject({ segmentsDone: 0, bytes: 0 });
    });

    it('takes the page’s fresh link when the stored one expired before the run', async () => {
      const site = movieSite(3, 'new');
      const { manager, outcome, state } = setup(site);
      state.fresh = { manifestUrl: `${BASE}master.m3u8?token=new`, context: { referer: 'https://site.example/watch' } };
      manager.sync([spec({ manifestUrl: `${BASE}master.m3u8?token=old`, audioTrackIds: [] })]);
      await manager.idle();
      expect(outcome()).toEqual({ status: 'downloaded' });
    });

    it('keeps the segment list stable when the size probe of a single file fails once', async () => {
      const mpd = 'https://media.example.org/ondemand/manifest.mpd';
      const videoUrl = 'https://media.example.org/ondemand/video_720.mp4';
      const site = new FakeMediaSite()
        .serve(mpd, dashSegmentBase)
        .serve(videoUrl, bodyFor(videoUrl, 100_000))
        .serve('https://media.example.org/ondemand/audio_en.mp4', bodyFor('https://media.example.org/ondemand/audio_en.mp4', 1000));
      site.failNext(videoUrl, { status: 503 });
      const { manager, outcome, storage } = setup(site, { chunkSize: 16_000 });
      manager.sync([spec({ protocol: 'dash', manifestUrl: mpd, variant: { id: 'video-0', height: 720, bandwidth: 2400000 } })]);
      await manager.idle();
      expect(outcome()).toEqual({ status: 'downloaded' });
      expect(new Set((await storage.listParts('t1', 'main')).map((part) => part.index)).size).toBe(7);

      site.failNext(videoUrl, { status: 403 });
      manager.sync([spec({ taskId: 't2', protocol: 'dash', manifestUrl: mpd, variant: { id: 'video-0', height: 720, bandwidth: 2400000 } })]);
      await manager.idle();
      expect(outcome('t2')).toEqual({ status: 'failed', message: EXPIRED_LINK_MESSAGE, reason: 'expired' });
    });

    it('stores the track layout with the plan, and adds it to a plan stored before Phase 8', async () => {
      const site = movieSite(3);
      const { manager, storage, outcome } = setup(site);
      manager.sync([spec()]);
      await manager.idle();
      expect(outcome()).toEqual({ status: 'downloaded' });
      const layout = [
        { trackId: 'main', trackType: 'main', segments: 3, initIndexes: [], discontinuityIndexes: [], container: 'mpeg-ts', durationSec: 12 },
        { trackId: 'audio-0', trackType: 'audio', segments: 3, initIndexes: [], discontinuityIndexes: [], container: 'mpeg-ts', durationSec: 12, name: 'English', language: 'en' },
      ];
      expect((await storage.getPlan('t1'))?.layout).toEqual(layout);

      // A Phase 7 plan: same segments, no layout. The next run reuses everything and adds it.
      const { layout: _layout, ...phase7 } = (await storage.getPlan('t1'))!;
      await storage.savePlan(phase7);
      const before = site.requests.length;
      manager.sync([]); // the service worker's next sync, once the outcome reached it
      manager.sync([spec()]);
      await manager.idle();
      expect(outcome()).toEqual({ status: 'downloaded' });
      expect(site.requests.slice(before).filter((request) => request.url.includes('/seg-'))).toEqual([]);
      expect((await storage.getPlan('t1'))?.layout).toEqual(layout);
    });

    it('signs a segment list by its shape, not its URLs', () => {
      const segment = (overrides: Partial<MediaSegment>): MediaSegment => ({
        id: 'main:0',
        trackId: 'main',
        trackType: 'main',
        index: 0,
        kind: 'media',
        url: 'https://cdn.example.com/a.ts?token=1',
        duration: 4,
        discontinuity: 0,
        container: 'mpeg-ts',
        ...overrides,
      });
      const plan = [segment({}), segment({ id: 'main:1', index: 1 })];
      expect(planSignature(plan.map((s) => ({ ...s, url: `${s.url}&renewed` })))).toBe(planSignature(plan));
      expect(planSignature([...plan, segment({ index: 2 })])).not.toBe(planSignature(plan));
      expect(planSignature([segment({}), segment({ index: 1, duration: 6 })])).not.toBe(planSignature(plan));
      expect(planSignature([segment({ byteRange: { offset: 0, length: 10 } }), plan[1] as MediaSegment])).not.toBe(planSignature(plan));
    });
  });

  describe('scenario: disk full', () => {
    const MB = 1024 * 1024;

    it('fails at once, before any request, when the disk is already full', async () => {
      const site = movieSite(3);
      const { manager, outcome } = setup(site, {
        estimateStorage: () => Promise.resolve({ usage: 900 * MB, quota: 1000 * MB }),
        reserveBytes: 256 * MB,
      });
      manager.sync([spec()]);
      await manager.idle();
      expect(outcome()).toEqual({ status: 'failed', message: diskFullMessage(100 * MB), reason: 'disk-full' });
      expect(site.requests).toEqual([]);
    });

    it('stops while space is left, keeps the segments, and continues once space was freed', async () => {
      const site = movieSite(8);
      const disk = { free: 2000 + 3.5 * SEGMENT_SIZE }; // the 4th segment goes below the 2000-byte reserve
      const { manager, outcome, storage, stored, expected } = setup(site, {
        estimateStorage: () => Promise.resolve({ usage: 0, quota: disk.free }),
        reserveBytes: 2000,
      });
      manager.sync([spec({ audioTrackIds: [], concurrency: 1 })]);
      await manager.idle();
      expect(outcome()).toEqual({ status: 'failed', message: diskFullMessage(SEGMENT_SIZE / 2 - 1000), reason: 'disk-full' });
      expect((await storage.inspectTask('t1')).complete).toHaveLength(4);

      disk.free = 10 * 1024 * 1024; // the user freed some space and pressed Retry
      manager.sync([]); // the service worker's next sync, once the outcome reached it
      manager.sync([spec({ audioTrackIds: [], concurrency: 1 })]);
      await manager.idle();
      expect(outcome()).toEqual({ status: 'downloaded' });
      expect(site.count(`${BASE}v720/seg-0.ts`)).toBe(1);
      expect(await stored('main')).toEqual(expected(urls('v720', 8)));
    });

    it('reports a write refused for lack of space as a full disk', async () => {
      class FullDisk extends IndexedDbSegmentStorage {
        error = new DOMException('quota', 'QuotaExceededError');
        override put(): Promise<void> {
          return Promise.reject(this.error);
        }
      }
      const storage = new FullDisk(new IDBFactory());
      const { manager, outcome } = setup(movieSite(3), { storage });
      manager.sync([spec({ audioTrackIds: [] })]);
      await manager.idle();
      expect(outcome()).toEqual({ status: 'failed', message: diskFullMessage(), reason: 'disk-full' });

      // Chrome may report a full disk as an unspecific error: the free space tells.
      storage.error = new DOMException('IO error', 'UnknownError');
      const disk = { free: 50 * MB };
      const low = setup(movieSite(3), {
        storage,
        estimateStorage: () => Promise.resolve({ usage: 0, quota: disk.free }),
        reserveBytes: 10 * MB,
      });
      low.manager.sync([spec({ audioTrackIds: [] })]);
      disk.free = MB; // filled up by something else after the run started
      await low.manager.idle();
      expect(low.outcome()).toEqual({ status: 'failed', message: diskFullMessage(MB), reason: 'disk-full' });

      disk.free = 50 * MB;
      const other = setup(movieSite(3), {
        storage,
        estimateStorage: () => Promise.resolve({ usage: 0, quota: disk.free }),
        reserveBytes: 10 * MB,
      });
      other.manager.sync([spec({ audioTrackIds: [] })]);
      await other.manager.idle();
      expect(other.outcome()).toEqual({ status: 'failed', message: 'Could not store a segment: IO error' });
    });
  });

  it('decrypts AES-128 segments before storing them', async () => {
    const keyBytes = Uint8Array.from({ length: 16 }, (_, i) => i * 7);
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt']);
    const site = new FakeMediaSite().serve(`${BASE}key.bin`, keyBytes);
    site.serve(`${BASE}enc/index.m3u8`, mediaPlaylist(3, '', '#EXT-X-KEY:METHOD=AES-128,URI="../key.bin"'));
    for (let i = 0; i < 3; i++) {
      const url = `${BASE}enc/seg-${i}.ts`;
      const iv = hexToBytes(i.toString(16).padStart(32, '0'));
      site.serve(url, new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, bodyFor(url, 2000))));
    }
    const { manager, outcome, stored, expected } = setup(site);
    manager.sync([spec({ manifestUrl: `${BASE}enc/index.m3u8`, variant: { id: 'video-0' }, audioTrackIds: [] })]);
    await manager.idle();
    expect(outcome()).toEqual({ status: 'downloaded' });
    expect(await stored('main')).toEqual(expected(urls('enc', 3), 2000));
    expect(site.count(`${BASE}key.bin`)).toBe(1);
  });

  describe('scenario: DASH with separate audio and video', () => {
    it('downloads both tracks with their initialization segments', async () => {
      const site = new FakeMediaSite().serve('https://cdn.example.com/vod/movie/manifest.mpd', dashStatic);
      site.serveAll('https://cdn.example.com/vod/movie/video/1080p/', 400).serveAll('https://cdn.example.com/vod/movie/audio/en/', 200);
      const { manager, outcome, storage } = setup(site);
      manager.sync([
        spec({
          protocol: 'dash',
          manifestUrl: 'https://cdn.example.com/vod/movie/manifest.mpd',
          variant: { id: 'video-0', height: 1080, bandwidth: 5000000 },
          audioTrackIds: ['audio-0'],
          concurrency: 8,
        }),
      ]);
      await manager.idle();
      expect(outcome()).toEqual({ status: 'downloaded' });
      expect(await storage.listParts('t1', 'main')).toHaveLength(160);
      expect(await storage.listParts('t1', 'audio-0')).toHaveLength(160);
    });
  });

  describe('scenario: large downloads with limited memory', () => {
    it('splits a single-file representation into ranged chunks and writes bounded parts', async () => {
      const mpd = 'https://media.example.org/ondemand/manifest.mpd';
      const video = new Uint8Array(bodyFor('https://media.example.org/ondemand/video_720.mp4', 100_000));
      const audio = new Uint8Array(bodyFor('https://media.example.org/ondemand/audio_en.mp4', 30_000));
      const site = new FakeMediaSite()
        .serve(mpd, dashSegmentBase)
        .serve('https://media.example.org/ondemand/video_720.mp4', video)
        .serve('https://media.example.org/ondemand/audio_en.mp4', audio);
      site.chunkSize = 4096;
      const { manager, outcome, stored, storage, reports } = setup(site, { chunkSize: 16_000, partSize: 8_000 });
      manager.sync([spec({ protocol: 'dash', manifestUrl: mpd, variant: { id: 'video-0', height: 720, bandwidth: 2400000 } })]);
      await manager.idle();
      expect(outcome()).toEqual({ status: 'downloaded' });
      expect(await stored('main')).toEqual(video);
      expect(await stored('audio-0')).toEqual(audio);
      const parts = await storage.listParts('t1', 'main');
      expect(new Set(parts.map((part) => part.index)).size).toBe(7); // ceil(100000 / 16000) ranged requests
      expect(Math.max(...parts.map((part) => part.size))).toBeLessThanOrEqual(8_000 + 4096);
      expect(site.requests.filter((r) => r.url.endsWith('video_720.mp4') && r.range?.startsWith('bytes=16000-'))).toHaveLength(1);
      // Kích thước của các đoạn range được biết trước: tổng dung lượng chính xác ngay từ báo cáo đầu tiên.
      const first = reports.find((report) => report.progress.segmentsTotal > 0)?.progress;
      expect(first?.tracks?.map((track) => track.declaredBytes)).toEqual([100_000, 30_000]);
      expect(first && estimateSize(first)).toMatchObject({ total: 130_000, exact: true });
    });

    it('streams a single file in parts when the server has no range support', async () => {
      const mpd = 'https://media.example.org/ondemand/manifest.mpd';
      const video = new Uint8Array(bodyFor('https://media.example.org/ondemand/video_720.mp4', 50_000));
      const site = new FakeMediaSite()
        .serve(mpd, dashSegmentBase)
        .serve('https://media.example.org/ondemand/video_720.mp4', video)
        .serve('https://media.example.org/ondemand/audio_en.mp4', bodyFor('https://media.example.org/ondemand/audio_en.mp4', 1000));
      site.supportsRanges = false;
      site.chunkSize = 5000;
      const { manager, outcome, stored, storage } = setup(site, { chunkSize: 16_000, partSize: 10_000 });
      manager.sync([spec({ protocol: 'dash', manifestUrl: mpd, variant: { id: 'video-0', height: 720, bandwidth: 2400000 } })]);
      await manager.idle();
      expect(outcome()).toEqual({ status: 'downloaded' });
      expect(await stored('main')).toEqual(video);
      expect((await storage.listParts('t1', 'main')).map((part) => part.part)).toEqual([0, 1, 2, 3, 4]);
    });
  });

  describe('refusals', () => {
    it('never downloads DRM-protected, SAMPLE-AES or live streams', async () => {
      const site = new FakeMediaSite()
        .serve(`${BASE}drm.mpd`, dashDrm)
        .serve(`${BASE}sample.m3u8`, hlsSampleAes)
        .serve(`${BASE}live.m3u8`, hlsLive);
      const { manager, outcome } = setup(site);
      manager.sync([
        spec({ taskId: 'drm', protocol: 'dash', manifestUrl: `${BASE}drm.mpd`, variant: { id: 'video-0' }, audioTrackIds: [] }),
        spec({ taskId: 'sample', manifestUrl: `${BASE}sample.m3u8`, variant: { id: 'video-0' }, audioTrackIds: [] }),
        spec({ taskId: 'live', manifestUrl: `${BASE}live.m3u8`, variant: { id: 'video-0' }, audioTrackIds: [] }),
      ]);
      await manager.idle();
      expect(outcome('drm')).toEqual({
        status: 'failed',
        message: 'Protected by Widevine / PlayReady DRM. DRM-protected streams are not supported.',
      });
      expect(outcome('sample')).toEqual({ status: 'failed', message: 'SAMPLE-AES encrypted streams are not supported yet.' });
      expect(outcome('live')).toEqual({ status: 'failed', message: 'Live streams cannot be downloaded yet.' });
      expect(site.requests.some((request) => /seg|\.m4s|\.ts/.test(request.url))).toBe(false);
    });

    it('fails clearly when the chosen quality disappeared', async () => {
      const { manager, outcome } = setup(movieSite(2));
      manager.sync([spec({ variant: { id: 'video-0', height: 2160, bandwidth: 1 } })]);
      await manager.idle();
      expect(outcome()).toEqual({ status: 'failed', message: 'The selected quality is no longer offered. Download the video again.' });
    });
  });
});

describe('DownloadManager: progressive files fetched by the engine (0.3.0)', () => {
  const FILE = 'https://media.example.net/files/protected.mp4';
  const SIZE = 200 * 1024;

  const fileSpec = (overrides: Partial<EngineTaskSpec> = {}): EngineTaskSpec =>
    spec({ protocol: 'progressive', manifestUrl: FILE, variant: { id: 'file' }, audioTrackIds: [], concurrency: 1, file: { container: 'mp4', bytes: SIZE }, ...overrides });

  function fileSetup(site: FakeMediaSite, overrides: Partial<DownloadManagerDeps> = {}) {
    const saves: SaveRequest[] = [];
    const blobs = new Map<string, Blob>();
    const revoked: string[] = [];
    const control = { accept: true };
    const context = setup(site, {
      saveFile: (request) => {
        saves.push(request);
        return Promise.resolve(control.accept);
      },
      createUrl: (blob) => {
        const url = `blob:chrome-extension://test/${blobs.size}`;
        blobs.set(url, blob);
        return url;
      },
      revokeUrl: (url) => {
        revoked.push(url);
      },
      partSize: 64 * 1024,
      ...overrides,
    });
    return { ...context, saves, blobs, revoked, control };
  }

  it('fetches the whole file into Blob parts (not IndexedDB), hands it over and holds its URL until released', async () => {
    const site = new FakeMediaSite();
    site.chunkSize = 16 * 1024;
    const bytes = bodyFor(FILE, SIZE);
    site.serve(FILE, bytes, 'video/mp4');
    const { manager, saves, blobs, revoked, reports, released, storage, outcome } = fileSetup(site);

    expect(manager.sync([fileSpec()])).toEqual(['t1']);
    await vi.waitFor(() => {
      expect(saves).toHaveLength(1);
    });
    const url = saves[0]?.url ?? '';
    expect(saves[0]).toEqual({ taskId: 't1', url, size: SIZE });
    const blob = blobs.get(url);
    expect(blob?.type).toBe('video/mp4');
    expect(new Uint8Array(await (blob as Blob).arrayBuffer())).toEqual(bytes); // the original bytes, untouched
    expect(await storage.taskIds()).toEqual([]);
    expect(site.requests).toEqual([{ url: FILE, range: undefined }]); // one plain request, no ranges

    // Progress in bytes against the known size, never more than 100 %, 100 % only when complete.
    const progress = reports.map((report) => report.progress);
    expect(progress.map((entry) => entry.bytes)).toEqual([...progress.map((entry) => entry.bytes)].sort((a, b) => a - b));
    expect(progress.some((entry) => entry.percent > 0 && entry.percent < 100)).toBe(true);
    expect(progress.at(-1)).toMatchObject({ segmentsTotal: 1, segmentsDone: 1, bytes: SIZE, percent: 100, tracks: [{ trackId: 'file', declaredBytes: SIZE }] });
    expect(estimateSize(progress[2] ?? progress[0]!)?.total).toBe(SIZE);
    expect(released).toContain('t1');

    // Chrome reads the file from the URL while saving: held until the service worker drops the task.
    expect(manager.running).toEqual(['t1']);
    expect(revoked).toEqual([]);
    await manager.syncSettled([]);
    await manager.idle();
    expect(revoked).toEqual([url]);
    expect(outcome()).toBeUndefined(); // saved: no failure, no cancellation
  });

  it('retries a failed request from the start of the file', async () => {
    const site = new FakeMediaSite();
    site.serve(FILE, bodyFor(FILE, SIZE), 'video/mp4');
    site.failNext(FILE, { status: 503 });
    const { manager, saves, reports } = fileSetup(site);
    manager.sync([fileSpec()]);
    await vi.waitFor(() => {
      expect(saves).toHaveLength(1);
    });
    expect(site.count(FILE)).toBe(2);
    expect(reports.at(-1)?.progress).toMatchObject({ retries: 1, bytes: SIZE });
    await manager.syncSettled([]);
  });

  it('takes a re-signed link from the newest detection when the link expired, and fails as expired without one', async () => {
    const renewed = `${FILE}?sig=new`;
    const site = new FakeMediaSite();
    site.serve(renewed, bodyFor(renewed, SIZE), 'video/mp4');
    site.failNext(FILE, { status: 403 });
    const { manager, saves, state, released } = fileSetup(site);
    state.fresh = { manifestUrl: renewed, context: { referer: 'https://site.example/watch' } };
    manager.sync([fileSpec()]);
    await vi.waitFor(() => {
      expect(saves).toHaveLength(1);
    });
    expect(site.count(renewed)).toBe(1);
    expect(released.length).toBeGreaterThanOrEqual(1); // the old context's rules go
    await manager.syncSettled([]);

    const expired = new FakeMediaSite();
    expired.failNext(FILE, { status: 403 });
    const failing = fileSetup(expired);
    failing.manager.sync([fileSpec()]);
    await failing.manager.idle();
    expect(failing.outcome()).toEqual({ status: 'failed', message: EXPIRED_LINK_MESSAGE, reason: 'expired' });
    expect(failing.saves).toEqual([]);
  });

  it('refuses a web page sent instead of the video', async () => {
    const site = new FakeMediaSite();
    site.serve(FILE, '<!doctype html><title>Sign in</title>', 'text/html');
    const { manager, outcome, saves } = fileSetup(site);
    manager.sync([fileSpec()]);
    await manager.idle();
    expect(outcome()).toMatchObject({ status: 'failed', message: expect.stringContaining('web page') as string });
    expect(saves).toEqual([]);
  });

  it('cancels while fetching: nothing is handed over', async () => {
    const site = new FakeMediaSite();
    site.latencyMs = 50;
    site.serve(FILE, bodyFor(FILE, SIZE), 'video/mp4');
    const { manager, outcome, saves } = fileSetup(site);
    manager.sync([fileSpec()]);
    await manager.cancel(['t1']);
    expect(outcome()).toEqual({ status: 'cancelled' });
    expect(saves).toEqual([]);
  });

  it('stops before fetching when the disk is nearly full', async () => {
    const site = new FakeMediaSite();
    site.serve(FILE, bodyFor(FILE, SIZE), 'video/mp4');
    const { manager, outcome } = fileSetup(site, { estimateStorage: () => Promise.resolve({ usage: 0, quota: 100 * 1024 * 1024 }) });
    manager.sync([fileSpec()]);
    await manager.idle();
    expect(outcome()).toMatchObject({ status: 'failed', reason: 'disk-full' });
    expect(site.count(FILE)).toBe(0);
  });

  it('lets go of a file the service worker did not take (cancelled meanwhile, or refused by Chrome)', async () => {
    const site = new FakeMediaSite();
    site.serve(FILE, bodyFor(FILE, SIZE), 'video/mp4');
    const { manager, control, revoked, saves } = fileSetup(site);
    control.accept = false;
    manager.sync([fileSpec()]);
    await manager.idle();
    expect(saves).toHaveLength(1);
    expect(revoked).toEqual([saves[0]?.url]);
    expect(manager.running).toEqual([]);
  });
});

describe('DownloadManager: progressive files continue from disk (0.6.0)', () => {
  const FILE = 'https://media.example.net/files/protected.mp4';
  const SIZE = 300 * 1024;
  const PART = 64 * 1024;
  const ETAG = '"v1"';
  const BYTES = bodyFor(FILE, SIZE);

  const fileSpec = (): EngineTaskSpec =>
    spec({ protocol: 'progressive', manifestUrl: FILE, variant: { id: 'file' }, audioTrackIds: [], concurrency: 1, file: { container: 'mp4', bytes: SIZE } });

  function diskSetup(site: FakeMediaSite, disk = new MemoryOutputFiles(), overrides: Partial<DownloadManagerDeps> = {}) {
    const saves: SaveRequest[] = [];
    const blobs = new Map<string, Blob>();
    const revoked: string[] = [];
    const context = setup(site, {
      saveFile: (request) => {
        saves.push(request);
        return Promise.resolve(true);
      },
      createUrl: (blob) => {
        const url = `blob:chrome-extension://test/${blobs.size}`;
        blobs.set(url, blob);
        return url;
      },
      revokeUrl: (url) => {
        revoked.push(url);
      },
      partialFiles: new SyncPartialFiles(disk),
      partSize: PART,
      ...overrides,
    });
    /** The bytes handed to Chrome. */
    const saved = async () => new Uint8Array(await (blobs.get(saves[0]?.url ?? '') as Blob).arrayBuffer());
    const run = async () => {
      context.manager.sync([fileSpec()]);
      await vi.waitFor(() => {
        expect(saves).toHaveLength(1);
      });
    };
    return { ...context, disk, saves, blobs, revoked, saved, run };
  }

  /** The record a run keeps next to the file. */
  const record = async (disk: MemoryOutputFiles) => JSON.parse(await ((await disk.read('t1.json')) as Blob).text()) as unknown;

  /** What a run that stopped after these bytes left on disk. */
  async function leave(disk: MemoryOutputFiles, bytes: Uint8Array, meta: object | undefined) {
    const store = new SyncPartialFiles(disk);
    const file = await store.open('t1.mp4');
    await file.append(bytes.slice());
    await file.close();
    if (meta) await store.put('t1.json', new TextEncoder().encode(JSON.stringify({ v: 1, ...meta })));
  }

  /** A first run cut off after 100 KiB with no retries left: 64 KiB (one whole part) stay on disk. */
  async function failedRun(site: FakeMediaSite, disk: MemoryOutputFiles) {
    site.cutNext(FILE, 100 * 1024);
    const first = diskSetup(site, disk, { retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 1 } });
    first.manager.sync([fileSpec()]);
    await first.manager.idle();
    expect(first.outcome()).toMatchObject({ status: 'failed' });
    expect(disk.files.get('t1.mp4')).toMatchObject({ size: PART, closed: true }); // kept, released
    return first;
  }

  it('continues a dropped connection with a Range request and If-Range, and keeps the file for the service worker to delete', async () => {
    const site = new FakeMediaSite();
    site.serve(FILE, BYTES, 'video/mp4', { etag: ETAG });
    site.cutNext(FILE, 150 * 1024);
    const { manager, disk, saves, saved, revoked, run, reports } = diskSetup(site);
    await run();
    expect(site.requests).toEqual([
      { url: FILE, range: undefined },
      { url: FILE, range: `bytes=${2 * PART}-`, ifRange: ETAG }, // the two whole parts written before the cut
    ]);
    expect(await saved()).toEqual(BYTES);
    expect(saves[0]).toMatchObject({ size: SIZE });
    expect(reports.at(-1)?.progress).toMatchObject({ bytes: SIZE, percent: 100, retries: 1 });
    expect(await record(disk)).toEqual({ v: 1, etag: ETAG, total: SIZE });

    await manager.syncSettled([]);
    await manager.idle();
    expect(revoked).toHaveLength(1);
    // Released, not deleted: the service worker deletes it once Chrome has saved it (a failed save is retried from it).
    expect((await disk.names()).sort()).toEqual(['t1.json', 't1.mp4']);
    expect(disk.files.get('t1.mp4')).toMatchObject({ size: SIZE, closed: true });
  });

  it('goes on when a server answers an open range with only part of the rest', async () => {
    const site = new FakeMediaSite();
    site.serve(FILE, BYTES, 'video/mp4', { etag: ETAG });
    site.maxOpenRangeBytes = 100 * 1024;
    const disk = new MemoryOutputFiles();
    await leave(disk, BYTES.subarray(0, PART), { etag: ETAG, total: SIZE });
    const { manager, saved, saves, run } = diskSetup(site, disk);
    await run();
    expect(site.requests.map((request) => request.range)).toEqual([`bytes=${PART}-`, `bytes=${PART + 100 * 1024}-`, `bytes=${PART + 200 * 1024}-`]);
    expect(saves[0]?.size).toBe(SIZE);
    expect(await saved()).toEqual(BYTES);
    await manager.syncSettled([]);
  });

  it('deletes the file of a run cancelled while the service worker was taking it', async () => {
    const site = new FakeMediaSite();
    site.serve(FILE, BYTES, 'video/mp4', { etag: ETAG });
    const disk = new MemoryOutputFiles();
    let answer: (taken: boolean) => void = () => undefined;
    const { manager } = diskSetup(site, disk, {
      saveFile: () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    });
    manager.sync([fileSpec()]);
    await vi.waitFor(() => {
      expect(disk.files.get('t1.mp4')).toMatchObject({ size: SIZE, closed: true });
    });
    const cancelling = manager.cancel(['t1']);
    answer(false); // the task was cancelled meanwhile
    await cancelling;
    expect(await disk.names()).toEqual([]);
  });

  it('shows what is on disk, not the size of a refused page, when a continuation is answered with one', async () => {
    const site = new FakeMediaSite();
    site.serve(FILE, BYTES, 'video/mp4', { etag: ETAG });
    site.failNext(FILE, { status: 200, headers: { 'content-type': 'text/html', 'content-length': '37' }, body: '<!doctype html><title>Sign in</title>' });
    const disk = new MemoryOutputFiles();
    await leave(disk, BYTES.subarray(0, PART), { etag: ETAG, total: SIZE });
    const { manager, outcome, last } = diskSetup(site, disk, { retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 1 } });
    manager.sync([fileSpec()]);
    await manager.idle();
    expect(outcome()).toMatchObject({ status: 'failed' });
    expect(last()?.progress).toMatchObject({ bytes: PART, tracks: [{ declaredBytes: SIZE }] });
    expect(disk.files.get('t1.mp4')?.size).toBe(PART);
  });

  it('continues the file a failed run left, in a later run (Retry, a restarted browser)', async () => {
    const site = new FakeMediaSite();
    site.serve(FILE, BYTES, 'video/mp4', { etag: ETAG });
    const disk = new MemoryOutputFiles();
    await failedRun(site, disk);
    site.requests.length = 0;

    const second = diskSetup(site, disk);
    await second.run();
    expect(second.reports[0]?.progress.bytes).toBe(PART); // what is on disk shows from the start
    expect(site.requests).toEqual([{ url: FILE, range: `bytes=${PART}-`, ifRange: ETAG }]);
    expect(await second.saved()).toEqual(BYTES);
    await second.manager.syncSettled([]);
  });

  it('continues with Last-Modified when there is no strong ETag', async () => {
    const site = new FakeMediaSite();
    const date = 'Wed, 01 Jan 2025 00:00:00 GMT';
    site.serve(FILE, BYTES, 'video/mp4', { etag: 'W/"weak"', lastModified: date });
    const disk = new MemoryOutputFiles();
    await failedRun(site, disk);
    expect(await record(disk)).toEqual({ v: 1, lastModified: date, total: SIZE });
    site.requests.length = 0;
    const second = diskSetup(site, disk);
    await second.run();
    expect(site.requests).toEqual([{ url: FILE, range: `bytes=${PART}-`, ifRange: date }]);
    expect(await second.saved()).toEqual(BYTES);
    await second.manager.syncSettled([]);
  });

  it('starts over when the file changed on the server (If-Range no longer matches)', async () => {
    const site = new FakeMediaSite();
    site.serve(FILE, BYTES, 'video/mp4', { etag: ETAG });
    const disk = new MemoryOutputFiles();
    await failedRun(site, disk);
    const changed = bodyFor(`${FILE}?v2`, SIZE + 1000);
    site.serve(FILE, changed, 'video/mp4', { etag: '"v2"' });
    site.requests.length = 0;

    const second = diskSetup(site, disk);
    await second.run();
    expect(site.requests).toEqual([{ url: FILE, range: `bytes=${PART}-`, ifRange: ETAG }]); // answered with 200: the new file
    expect(await second.saved()).toEqual(changed);
    expect(second.saves[0]?.size).toBe(SIZE + 1000);
    expect(await record(disk)).toEqual({ v: 1, etag: '"v2"', total: SIZE + 1000 });
    await second.manager.syncSettled([]);
  });

  it('starts over without a validator: no ETag or Last-Modified, a weak ETag only, or a compressed body', async () => {
    for (const extra of [{}, { etag: 'W/"weak"' }, { etag: ETAG, headers: { 'content-encoding': 'gzip' } }]) {
      const site = new FakeMediaSite();
      site.serve(FILE, BYTES, 'video/mp4', extra);
      site.cutNext(FILE, 100 * 1024);
      const { manager, saved, run } = diskSetup(site);
      await run();
      expect(site.requests).toEqual([
        { url: FILE, range: undefined },
        { url: FILE, range: undefined },
      ]);
      expect(await saved()).toEqual(BYTES);
      await manager.syncSettled([]);
    }
  });

  it('saves a complete file on disk without fetching it again; a 416 confirms one whose size was not known', async () => {
    const site = new FakeMediaSite();
    site.serve(FILE, BYTES, 'video/mp4', { etag: ETAG });
    const disk = new MemoryOutputFiles();
    await leave(disk, BYTES, { etag: ETAG, total: SIZE });
    const known = diskSetup(site, disk);
    await known.run();
    expect(site.requests).toEqual([]);
    expect(await known.saved()).toEqual(BYTES);
    await known.manager.syncSettled([]);

    const other = new MemoryOutputFiles();
    await leave(other, BYTES, { etag: ETAG });
    const unknown = diskSetup(site, other);
    await unknown.run();
    expect(site.requests).toEqual([{ url: FILE, range: `bytes=${SIZE}-`, ifRange: ETAG }]);
    expect(await unknown.saved()).toEqual(BYTES);
    await unknown.manager.syncSettled([]);
  });

  it('starts over when a continuation brings other bytes than asked for', async () => {
    const site = new FakeMediaSite();
    site.serve(FILE, BYTES, 'video/mp4', { etag: ETAG });
    site.failNext(FILE, { status: 206, headers: { 'content-range': `bytes 0-4/${SIZE}` }, body: 'GGGGG' });
    const disk = new MemoryOutputFiles();
    await leave(disk, BYTES.subarray(0, PART), { etag: ETAG, total: SIZE });
    const { manager, saved, run } = diskSetup(site, disk);
    await run();
    expect(site.requests).toEqual([
      { url: FILE, range: `bytes=${PART}-`, ifRange: ETAG },
      { url: FILE, range: undefined },
    ]);
    expect(await saved()).toEqual(BYTES);
    await manager.syncSettled([]);
  });

  it('keeps the file when a continuation is answered with a web page, and continues it on the next attempt', async () => {
    const site = new FakeMediaSite();
    site.serve(FILE, BYTES, 'video/mp4', { etag: ETAG });
    site.failNext(FILE, { status: 200, headers: { 'content-type': 'text/html' }, body: '<!doctype html><title>Sign in</title>' });
    const disk = new MemoryOutputFiles();
    await leave(disk, BYTES.subarray(0, PART), { etag: ETAG, total: SIZE });
    const { manager, saved, run } = diskSetup(site, disk);
    await run();
    // Had the page started the file over, the second request would ask for the whole file.
    expect(site.requests).toEqual([
      { url: FILE, range: `bytes=${PART}-`, ifRange: ETAG },
      { url: FILE, range: `bytes=${PART}-`, ifRange: ETAG },
    ]);
    expect(await saved()).toEqual(BYTES);
    await manager.syncSettled([]);
  });

  it('deletes the file when the task is cancelled mid-download', async () => {
    const site = new FakeMediaSite();
    site.chunkSize = 16 * 1024;
    site.serve(FILE, BYTES, 'video/mp4', { etag: ETAG });
    // Every read waits a little, so the cancel lands mid-body.
    const fetch: typeof site.fetch = async (url, init) => {
      const response = await site.fetch(url, init);
      const reader = response.body?.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise((done) => setTimeout(done, 5));
          const next = await reader?.read();
          if (!next || next.done) controller.close();
          else controller.enqueue(next.value);
        },
      });
      return new Response(body, { status: response.status, headers: response.headers });
    };
    const disk = new MemoryOutputFiles();
    const { manager, outcome, saves } = diskSetup(site, disk, { fetchFor: () => fetch });
    manager.sync([fileSpec()]);
    await vi.waitFor(() => {
      expect(disk.files.get('t1.mp4')?.size).toBeGreaterThan(0);
    });
    await manager.cancel(['t1']);
    expect(outcome()).toEqual({ status: 'cancelled' });
    expect(saves).toEqual([]);
    expect(await disk.names()).toEqual([]);
  });

  it('fails as disk-full when the disk fills up while the file is written, keeping what was written', async () => {
    const site = new FakeMediaSite();
    site.serve(FILE, BYTES, 'video/mp4', { etag: ETAG });
    const disk = new MemoryOutputFiles();
    disk.quota = 2 * PART;
    const { manager, outcome } = diskSetup(site, disk);
    manager.sync([fileSpec()]);
    await manager.idle();
    expect(outcome()).toMatchObject({ status: 'failed', reason: 'disk-full' });
    expect(disk.files.get('t1.mp4')).toMatchObject({ size: 2 * PART, closed: true });
  });

  it('streams into Blob parts when disk files cannot be opened', async () => {
    const site = new FakeMediaSite();
    site.serve(FILE, BYTES, 'video/mp4', { etag: ETAG });
    site.cutNext(FILE, 100 * 1024);
    const disk = new MemoryOutputFiles();
    disk.failOpen = new Error('no OPFS here');
    const { manager, saved, run } = diskSetup(site, disk);
    await run();
    // The parts held in memory are continued within the run all the same.
    expect(site.requests).toEqual([
      { url: FILE, range: undefined },
      { url: FILE, range: `bytes=${PART}-`, ifRange: ETAG },
    ]);
    expect(await saved()).toEqual(BYTES);
    await manager.syncSettled([]);
  });
});

describe('DownloadManager: subtitle tracks (0.7.0)', () => {
  it('downloads the chosen WebVTT tracks with the segments, a single subtitle file whole, named in the layout', async () => {
    const base = 'https://cdn.example.com/vod/subbed/';
    const vtt = (text: string) => `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n${text}\n`;
    const site = new FakeMediaSite().serve(`${base}manifest.mpd`, dashSubtitles);
    site.serveAll(`${base}video/`, 400).serveAll(`${base}audio/`, 200);
    site.serve(`${base}subs/en.vtt`, vtt('Hello'), 'text/vtt');
    for (const n of [1, 2, 3]) site.serve(`${base}subs/fr/${n}.vtt`, vtt(`Bonjour ${n}`), 'text/vtt');
    // Chunks this small would cut any single file into ranged pieces: a subtitle file stays whole.
    const { manager, outcome, storage } = setup(site, { chunkSize: 16 });
    manager.sync([
      spec({
        protocol: 'dash',
        manifestUrl: `${base}manifest.mpd`,
        variant: { id: 'video-0', height: 720, bandwidth: 2000000 },
        audioTrackIds: [],
        subtitleTrackIds: ['subtitle-0', 'subtitle-1'],
      }),
    ]);
    await manager.idle();
    expect(outcome()).toEqual({ status: 'downloaded' });
    expect(site.requests.filter((request) => request.url === `${base}subs/en.vtt`)).toEqual([{ url: `${base}subs/en.vtt`, range: undefined }]);
    const text = async (trackId: string) => {
      const parts = await storage.trackData('t1', trackId);
      return new Blob(parts.map((part) => part.data)).text();
    };
    expect(await text('subtitle-0')).toBe(vtt('Hello'));
    expect(await text('subtitle-1')).toBe([1, 2, 3].map((n) => vtt(`Bonjour ${n}`)).join(''));
    const layout = (await storage.getPlan('t1'))?.layout ?? [];
    expect(layout.filter((track) => track.trackType === 'subtitle')).toEqual([
      expect.objectContaining({ trackId: 'subtitle-0', name: 'English', language: 'en', container: 'webvtt', segments: 1 }),
      expect.objectContaining({ trackId: 'subtitle-1', language: 'fr', container: 'webvtt', segments: 3 }),
    ]);
  });

  it('never fails the video for subtitles: a missing playlist leaves its track out, a refused segment is stored empty', async () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n';
    const master = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",LANGUAGE="en",URI="subs/en/index.m3u8"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="Deutsch",LANGUAGE="de",URI="subs/de/index.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,SUBTITLES="s"',
      'v720/index.m3u8',
    ].join('\n');
    const site = movieSite(4).serve(`${BASE}subbed.m3u8`, master);
    site.serve(`${BASE}subs/en/index.m3u8`, mediaPlaylist(4).replaceAll('.ts', '.vtt'));
    for (const n of [0, 1, 3]) site.serve(`${BASE}subs/en/seg-${n}.vtt`, vtt, 'text/vtt');
    // subs/en/seg-2.vtt and the German playlist answer 404.
    const { manager, outcome, storage } = setup(site);
    manager.sync([spec({ manifestUrl: `${BASE}subbed.m3u8`, audioTrackIds: [], subtitleTrackIds: ['subtitle-0', 'subtitle-1'] })]);
    await manager.idle();
    expect(outcome()).toEqual({ status: 'downloaded' });
    const layout = (await storage.getPlan('t1'))?.layout ?? [];
    expect(layout.map((track) => track.trackId)).toEqual(['main', 'subtitle-0']);
    const { complete } = await storage.inspectTask('t1');
    expect(complete.filter((segment) => segment.trackId === 'subtitle-0').map((segment) => segment.bytes)).toEqual([vtt.length, vtt.length, 0, vtt.length]);
  });

  it('downloads page subtitle files whole after the stream, marked in the layout; a missing one is stored empty (0.7.2)', async () => {
    const vtt = 'WEBVTT\nLanguage: zh\n\n00:01.000 --> 00:02.000\n你好\n';
    const zh = `${BASE}subs/captions.zh.vtt.r20240612`;
    const site = movieSite(4).serve(`${BASE}subbed.m3u8`, ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720', 'v720/index.m3u8'].join('\n'));
    site.serve(zh, vtt, 'text/vtt');
    // A page file's link cannot be renewed: its 404 must not spend the manifest's refreshes.
    const freshSource = vi.fn(() => Promise.resolve(null));
    const { manager, outcome, storage } = setup(site, { chunkSize: 16, freshSource });
    manager.sync([
      spec({
        manifestUrl: `${BASE}subbed.m3u8`,
        audioTrackIds: [],
        pageSubtitles: [
          { id: 'page-0', url: zh, name: 'Chinese', language: 'zh' },
          { id: 'page-1', url: `${BASE}subs/gone.vtt`, name: 'gone' },
        ],
      }),
    ]);
    await manager.idle();
    expect(outcome()).toEqual({ status: 'downloaded' });
    const layout = (await storage.getPlan('t1'))?.layout ?? [];
    expect(layout.filter((track) => track.trackType === 'subtitle')).toEqual([
      expect.objectContaining({ trackId: 'page-0', name: 'Chinese', language: 'zh', container: 'webvtt', segments: 1, pageFile: true }),
      expect.objectContaining({ trackId: 'page-1', name: 'gone', segments: 1, pageFile: true }),
    ]);
    const parts = await storage.trackData('t1', 'page-0');
    expect(await new Blob(parts.map((part) => part.data)).text()).toBe(vtt);
    const { complete } = await storage.inspectTask('t1');
    expect(complete.filter((segment) => segment.trackId === 'page-1').map((segment) => segment.bytes)).toEqual([0]);
    expect(freshSource).not.toHaveBeenCalled();
  });
});
