import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DownloadCoordinator, saveFailureMessage, type EngineChannel } from '@/core/download/download-coordinator';
import { DownloadManager } from '@/core/download/download-manager';
import { IndexedDbSegmentStorage } from '@/core/download/download-storage';
import { TaskStore } from '@/core/download/task-store';
import { probeJob } from '@/core/media/probe';
import { MediaManager } from '@/core/media/media-manager';
import type { DownloadTask } from '@/core/models/download-task';
import type { StreamingProtocol } from '@/core/models/detected-stream';
import { ManifestFetcher } from '@/core/network/manifest-fetcher';
import { DashAdapter } from '@/core/protocols/dash/dash-adapter';
import { HlsAdapter } from '@/core/protocols/hls/hls-adapter';
import { ProtocolRegistry } from '@/core/protocols/protocol-adapter';
import { Engine } from '@/offscreen/engine';
import { DEFAULT_SETTINGS, type OutputFormat } from '@/shared/settings/settings';
import { FakeFiles, FakeNotifier } from '@tests/fakes/fake-files';
import { FakeStorageArea } from '@tests/fakes/fake-storage';
import { NodeFfmpegRunner } from '@tests/fakes/ffmpeg-node';
import { FakeMediaSite } from '@tests/fakes/media-site';
import { serveDash, serveHls, serveMuxedHls, SYNTHETIC_BASE } from '@tests/fakes/synthetic-site';
import { makeTask } from '@tests/fakes/tasks';
import { syntheticMedia, type SyntheticMedia } from '@tests/fixtures/media/synthetic-media';

/**
 * Downloads real (synthetic) H.264/AAC streams end to end, merges them with
 * the real FFmpeg.wasm core and saves the file: coordinator, download
 * manager, segment storage, media manager, FFmpeg and a stand-in for
 * chrome.downloads, wired as in the extension, with the popup closed
 * throughout. Spec scenarios 1 (HLS MPEG-TS), 2 (HLS fMP4) and 3 (DASH with
 * separate audio and video). The saved files are then read back by FFmpeg.
 */

let media: SyntheticMedia;
const inspector = new NodeFfmpegRunner();

beforeAll(async () => {
  media = await syntheticMedia();
}, 60_000);

/** What ffprobe says about a saved file, as raw JSON (tags included). */
async function probeSaved(data: Uint8Array, name: string): Promise<{ format: Record<string, unknown>; streams: Record<string, unknown>[] }> {
  const result = await inspector.run(probeJob(name, new Blob([new Uint8Array(data)])));
  return JSON.parse(result.stdout) as { format: Record<string, unknown>; streams: Record<string, unknown>[] };
}

function pipeline(site: FakeMediaSite) {
  const store = new TaskStore(new FakeStorageArea('local'), new FakeStorageArea('session'));
  const storage = new IndexedDbSegmentStorage(new IDBFactory());
  const ffmpeg = new NodeFfmpegRunner();
  const files = new FakeFiles();
  const notifier = new FakeNotifier();
  const coordinatorRef: { current?: DownloadCoordinator } = {};
  files.onChanged = (id) => void coordinatorRef.current?.handleFileChange(id);
  const downloads = new DownloadManager({
    storage,
    protocols: () => {
      const fetcher = new ManifestFetcher({ fetch: site.fetch });
      return new ProtocolRegistry().register(new HlsAdapter({ fetcher })).register(new DashAdapter({ fetcher }));
    },
    fetchFor: () => site.fetch,
    freshSource: () => Promise.resolve(null),
    releaseContexts: () => Promise.resolve(),
    report: (report) => void coordinatorRef.current?.handleReport(report),
    reportIntervalMs: 0,
  });
  const mediaManager = new MediaManager({
    storage,
    ffmpeg,
    save: (request) => coordinatorRef.current?.startSave(request) ?? Promise.resolve(false),
    report: (report) => void coordinatorRef.current?.handleMediaReport(report),
    reportIntervalMs: 0,
  });
  const offscreen = new Engine(downloads, mediaManager);
  let open = false;
  const engine: EngineChannel = {
    exists: () => Promise.resolve(open),
    ensure: () => {
      open = true;
      return Promise.resolve();
    },
    close: () => {
      open = false;
      return Promise.resolve();
    },
    sync: (work) => offscreen.sync(work),
    cancel: (ids) => offscreen.cancel(ids),
    reacquireContexts: () => Promise.resolve(),
  };
  const coordinator = new DownloadCoordinator({
    store,
    storage,
    engine,
    acquireContext: () => Promise.resolve(() => Promise.resolve()),
    getSettings: () => Promise.resolve({ ...DEFAULT_SETTINGS, maxActiveTasks: 2 }),
    getStream: () => Promise.resolve(undefined),
    files,
    notifier,
  });
  coordinatorRef.current = coordinator;

  /** Queues a download as the popup would. */
  const download = async (id: string, protocol: StreamingProtocol, manifestUrl: string, variantId: string, audioTrackIds: string[], format: OutputFormat = 'auto') => {
    const task = makeTask(id, {
      source: { protocol, manifestUrl, title: `Test video ${id}`, tabId: 1, streamId: id },
      selection: { variantId, variantLabel: '90p', audioTrackIds, audioTrackNames: audioTrackIds.map(() => 'English') },
      output: { baseName: id, format },
    });
    await store.add([{ task, context: {} }]);
    await coordinator.pump();
  };
  /** Waits until every task completed or failed and the engine closed. */
  const finished = async (): Promise<DownloadTask[]> => {
    await vi.waitFor(
      async () => {
        const tasks = await store.list();
        expect(tasks.every((task) => task.status === 'failed' || task.status === 'completed')).toBe(true);
        expect(open).toBe(false);
      },
      { timeout: 30_000, interval: 20 },
    );
    return store.list();
  };
  return { store, storage, ffmpeg, files, notifier, coordinator, download, finished };
}

const duration = (probe: { format: Record<string, unknown> }) => Number(probe.format['duration']);

describe('media pipeline (real downloads, real FFmpeg, saved files)', () => {
  it('downloads HLS MPEG-TS, HLS fMP4 and DASH streams, merges each into one file and saves it', async () => {
    const site = new FakeMediaSite();
    const ts = serveHls(site, media, 'ts');
    const fmp4 = serveHls(site, media, 'fmp4');
    const dash = serveDash(site, media);
    const { download, finished, ffmpeg, files, notifier, storage } = pipeline(site);

    // video-1 is the 160×90 rendition in each manifest; audio-0 is English.
    await download('hls-ts', 'hls', ts, 'video-1', ['audio-0']);
    await download('hls-fmp4', 'hls', fmp4, 'video-1', ['audio-0']);
    await download('dash', 'dash', dash, 'video-1', ['audio-0'], 'mkv');
    const tasks = await finished();

    expect(tasks.map((task) => [task.id, task.status, task.output.saved?.path])).toEqual([
      ['hls-ts', 'completed', '/Downloads/hls-ts.mp4'],
      ['hls-fmp4', 'completed', '/Downloads/hls-fmp4.mp4'],
      ['dash', 'completed', '/Downloads/dash.mkv'],
    ]);
    for (const task of tasks) {
      const name = task.output.saved?.path.split('/').pop() ?? '';
      const bytes = await files.bytesOf(name);
      expect(bytes?.length).toBe(task.output.saved?.bytes);
      const probe = await probeSaved(bytes ?? new Uint8Array(), name);
      expect(probe.format['format_name']).toContain(task.id === 'dash' ? 'matroska' : 'mp4');
      expect(duration(probe)).toBeCloseTo(8, 0);
      expect(probe.format['tags']).toMatchObject({ title: `Test video ${task.id}` });
      expect(probe.streams.map((stream) => [stream['codec_type'], stream['codec_name']])).toEqual([
        ['video', 'h264'],
        ['audio', 'aac'],
      ]);
      expect(probe.streams[0]).toMatchObject({ width: 160, height: 90 });
      // The audio track keeps its manifest name and language (ISO 639-2 codes); MP4 names tracks by their handler.
      // (The DASH track has no label, only its language, so it gets no name.)
      expect(probe.streams[1]?.['tags']).toMatchObject({ language: 'eng', ...(task.id === 'dash' ? {} : { handler_name: 'English' }) });
      if (task.id === 'dash') expect(probe.streams[1]?.['tags']).not.toHaveProperty('title');
      expect(probe.streams[1]?.['disposition']).toMatchObject({ default: 1 });
    }
    // One FFmpeg instance for all three (the worker is kept between jobs): per task 2 probes, 1 merge, 1 check.
    expect(ffmpeg.loads).toBe(1);
    expect(ffmpeg.runs).toBe(12);
    // Temporary segments are deleted once a file is saved; each completion is announced.
    await vi.waitFor(async () => {
      expect(await storage.taskIds()).toEqual([]);
    });
    expect(notifier.shown.map((shown) => shown.kind)).toEqual(['completed', 'completed', 'completed']);
  });

  it('merges a single media playlist of muxed audio and video', async () => {
    const site = new FakeMediaSite();
    const url = serveMuxedHls(site, media);
    const { download, finished, files } = pipeline(site);
    await download('muxed', 'hls', url, 'video-0', []);
    const [task] = await finished();
    expect(task?.status).toBe('completed');
    const probe = await probeSaved((await files.bytesOf('muxed.mp4')) ?? new Uint8Array(), 'muxed.mp4');
    expect(probe.streams.map((stream) => stream['codec_type'])).toEqual(['video', 'audio']);
    expect(duration(probe)).toBeCloseTo(8, 0);
  });

  it('joins the runs of a playlist whose timestamps restart at a discontinuity', async () => {
    const site = new FakeMediaSite();
    serveMuxedHls(site, media);
    // The same two 2-second segments twice: the second pair starts again at the first pair's timestamps.
    const base = `${SYNTHETIC_BASE}muxed/`;
    const durations = media.ts.muxed.durations;
    site.serve(
      `${base}restart.m3u8`,
      [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:2',
        '#EXT-X-MEDIA-SEQUENCE:0',
        `#EXTINF:${durations[0]},`,
        'seg-0.ts',
        `#EXTINF:${durations[1]},`,
        'seg-1.ts',
        '#EXT-X-DISCONTINUITY',
        `#EXTINF:${durations[0]},`,
        'seg-0.ts?again',
        `#EXTINF:${durations[1]},`,
        'seg-1.ts?again',
        '#EXT-X-ENDLIST',
      ].join('\n'),
    );
    site.serve(`${base}seg-0.ts?again`, media.ts.muxed.segments[0] ?? new Uint8Array());
    site.serve(`${base}seg-1.ts?again`, media.ts.muxed.segments[1] ?? new Uint8Array());
    const { download, finished, files, ffmpeg } = pipeline(site);
    await download('restart', 'hls', `${base}restart.m3u8`, 'video-0', []);
    const [task] = await finished();
    expect(task?.status).toBe('completed');
    // Two runs, joined by the concat demuxer: 8 seconds in order, not 4 seconds folded onto themselves.
    expect(ffmpeg.jobs.find((job) => job.tool === 'ffmpeg')?.args.join(' ')).toContain('-f concat -safe 0 -i /in/t1.ffconcat');
    const probe = await probeSaved((await files.bytesOf('restart.mp4')) ?? new Uint8Array(), 'restart.mp4');
    expect(duration(probe)).toBeCloseTo(8, 0);
  });

  it('keeps the segments when Chrome cannot save the file, and saves it after Retry', async () => {
    const site = new FakeMediaSite();
    const url = serveMuxedHls(site, media);
    const { download, finished, files, store, storage, coordinator, notifier } = pipeline(site);
    files.manual = true;
    await download('full', 'hls', url, 'video-0', []);
    await vi.waitFor(() => {
      expect(files.entries.size).toBe(1);
    });
    files.finish(1, 'FILE_NO_SPACE');
    const [failed] = await finished();
    expect(failed).toMatchObject({ status: 'failed', statusMessage: saveFailureMessage('FILE_NO_SPACE') });
    expect(await storage.taskIds()).toEqual(['full']);
    expect(notifier.shown).toEqual([{ kind: 'failed', taskId: 'full' }]);

    files.manual = false;
    const requests = site.requests.length;
    await coordinator.retry(['full']);
    const [saved] = await finished();
    expect(saved).toMatchObject({ status: 'completed', output: { saved: { path: '/Downloads/full.mp4' } } });
    // Retry merged again from the kept segments: nothing was downloaded twice.
    expect(site.requests.slice(requests).filter((request) => request.url.includes('/seg-'))).toEqual([]);
    expect((await store.list())[0]?.statusMessage).toBeUndefined();
  });
});
