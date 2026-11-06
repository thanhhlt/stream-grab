import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { CONTEXT_LOST_MESSAGE, DownloadCoordinator, type EngineChannel } from '@/core/download/download-coordinator';
import { DownloadManager } from '@/core/download/download-manager';
import { IndexedDbSegmentStorage } from '@/core/download/download-storage';
import { mergeStoredTasks, TaskStore } from '@/core/download/task-store';
import type { DetectedStream } from '@/core/models/detected-stream';
import type { DownloadTask, EngineReport, TaskProgress } from '@/core/models/download-task';
import { ManifestFetcher, type FetchFunction } from '@/core/network/manifest-fetcher';
import { DashAdapter } from '@/core/protocols/dash/dash-adapter';
import { HlsAdapter } from '@/core/protocols/hls/hls-adapter';
import { ProtocolRegistry } from '@/core/protocols/protocol-adapter';
import { MediaManager } from '@/core/media/media-manager';
import { Engine } from '@/offscreen/engine';
import { STORAGE_KEYS } from '@/shared/constants';
import { DEFAULT_SETTINGS } from '@/shared/settings/settings';
import { crashable, until } from '@tests/fakes/crash';
import { fakeFfmpeg } from '@tests/fakes/fake-ffmpeg';
import { FakeFiles, FakeNotifier } from '@tests/fakes/fake-files';
import { FakeStorageArea } from '@tests/fakes/fake-storage';
import { bodyFor, type FakeMediaSite } from '@tests/fakes/media-site';
import { MOVIE_BASE, movieSite, SEGMENT_SIZE } from '@tests/fakes/movie-site';
import { makeTask } from '@tests/fakes/tasks';

/**
 * Scenario "popup closed during download", end to end without Chrome: the
 * service worker's coordinator and the offscreen engine are wired together
 * in process (their only link in the extension is runtime messaging), and no
 * popup exists at all. Tasks go queued → downloading → downloaded →
 * processing → completed on their own; the popup would only read the task
 * store. Segment bodies here are filler bytes that prove storage order, so
 * FFmpeg is replaced by a stand-in whose "merge" writes its inputs one after
 * the other: the saved file shows how the segments were assembled
 * (tests/integration/media-pipeline.test.ts runs real media through FFmpeg).
 */

const settled = (entry: DownloadTask | undefined): boolean => entry?.status === 'completed';

function task(id: string, createdAt: number): DownloadTask {
  return makeTask(id, {
    createdAt,
    source: { protocol: 'hls', manifestUrl: `${MOVIE_BASE}master.m3u8`, title: `Movie ${id}`, tabId: 1, streamId: 's1' },
    selection: {
      variantId: 'video-0',
      variantLabel: '720p',
      height: 720,
      bandwidth: 2000000,
      audioTrackIds: ['audio-0'],
      audioTrackNames: ['English'],
    },
  });
}

/** Deleting a task's data takes a while, as it does for a multi-GB download in a real browser. */
class SlowDeleteStorage extends IndexedDbSegmentStorage {
  override async deleteTask(taskId: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await super.deleteTask(taskId);
  }
}

function createPipeline(segments: number) {
  const site = movieSite(segments);
  const store = new TaskStore(new FakeStorageArea('local'), new FakeStorageArea('session'));
  const storage = new SlowDeleteStorage(new IDBFactory());
  let engineOpen = false;
  let peakRunning = 0;
  /** Stored parts of each task at the moment the engine was closed (closing destroys the document). */
  const partsAtClose: Record<string, number>[] = [];

  const coordinatorRef: { current?: DownloadCoordinator } = {};
  const files = new FakeFiles();
  files.onChanged = (id) => void coordinatorRef.current?.handleFileChange(id);
  const notifier = new FakeNotifier();
  const manager = new DownloadManager({
    storage,
    protocols: () => {
      const fetcher = new ManifestFetcher({ fetch: site.fetch });
      return new ProtocolRegistry().register(new HlsAdapter({ fetcher })).register(new DashAdapter({ fetcher }));
    },
    fetchFor: () => site.fetch,
    freshSource: (taskId) => coordinatorRef.current?.freshSource(taskId) ?? Promise.resolve(null),
    releaseContexts: () => Promise.resolve(),
    report: (report) => {
      peakRunning = Math.max(peakRunning, manager.running.length);
      void coordinatorRef.current?.handleReport(report);
    },
    reportIntervalMs: 0,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, maxRetryAfterMs: 2 },
  });
  const media = new MediaManager({
    storage,
    ffmpeg: fakeFfmpeg(),
    save: (request) => coordinatorRef.current?.startSave(request) ?? Promise.resolve(false),
    report: (report) => void coordinatorRef.current?.handleMediaReport(report),
    reportIntervalMs: 0,
  });
  const offscreen = new Engine(manager, media);
  // Stands in for runtime messaging to the offscreen document (same calls as its message handlers).
  const engine: EngineChannel = {
    exists: () => Promise.resolve(engineOpen),
    ensure: () => {
      engineOpen = true;
      return Promise.resolve();
    },
    close: async () => {
      const snapshot: Record<string, number> = {};
      for (const entry of await store.list()) snapshot[entry.id] = (await storage.listParts(entry.id)).length;
      partsAtClose.push(snapshot);
      engineOpen = false;
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
    getSettings: () => Promise.resolve({ ...DEFAULT_SETTINGS, maxActiveTasks: 1, segmentConcurrency: 3 }),
    getStream: () => Promise.resolve(undefined),
    files,
    notifier,
  });
  coordinatorRef.current = coordinator;

  const statuses = async () => (await store.list()).map((entry) => entry.status);
  const allSettled = async () => (await store.list()).map(settled);
  return {
    site,
    store,
    storage,
    files,
    notifier,
    coordinator,
    manager,
    statuses,
    allSettled,
    partsAtClose,
    engineOpen: () => engineOpen,
    peakRunning: () => peakRunning,
  };
}

describe('download pipeline (coordinator + engine, no popup)', () => {
  it('downloads queued tasks one after another, merges and saves them, cleans up and closes the engine', async () => {
    const { store, storage, files, notifier, coordinator, allSettled, engineOpen, peakRunning } = createPipeline(8);
    await store.add([
      { task: task('a', 1), context: {} },
      { task: task('b', 2), context: {} },
    ]);
    await coordinator.pump();

    await vi.waitFor(
      async () => {
        expect(await allSettled()).toEqual([true, true]);
      },
      { timeout: 5000, interval: 10 },
    );
    for (const entry of await store.list()) {
      expect(entry.progress).toMatchObject({ segmentsTotal: 16, segmentsDone: 16, percent: 100, bytes: 16 * SEGMENT_SIZE });
      // Saved under its name, the video track then the audio track, each in playlist order.
      expect(entry.output.saved).toMatchObject({ path: `/Downloads/Movie_${entry.id}.mp4`, bytes: 16 * SEGMENT_SIZE });
      expect(await files.bytesOf(`Movie_${entry.id}.mp4`)).toEqual(concat(expectedTrack('v720', 8), expectedTrack('audio', 8)));
      // The temporary segments go once the file is saved.
      await vi.waitFor(async () => {
        expect(await storage.listParts(entry.id)).toEqual([]);
      });
    }
    expect(notifier.shown).toEqual([
      { kind: 'completed', taskId: 'a' },
      { kind: 'completed', taskId: 'b' },
    ]);
    expect(peakRunning()).toBe(1); // Settings: one simultaneous download
    await vi.waitFor(() => {
      expect(engineOpen()).toBe(false);
    });
  });

  it('cancels a running task, deletes its data and moves on to the next one', async () => {
    const { site, store, storage, coordinator, statuses } = createPipeline(40);
    site.latencyFor = (url) => (url.includes('/seg-') ? 5 : 0);
    await store.add([
      { task: task('a', 1), context: {} },
      { task: task('b', 2), context: {} },
    ]);
    await coordinator.pump();
    await vi.waitFor(
      async () => {
        expect((await store.list())[0]?.progress?.segmentsDone ?? 0).toBeGreaterThan(2);
      },
      { timeout: 5000, interval: 5 },
    );

    await coordinator.cancel(['a']);
    await vi.waitFor(
      async () => {
        expect(await statuses()).toEqual(['cancelled', 'completed']);
      },
      { timeout: 10_000, interval: 10 },
    );
    await vi.waitFor(async () => {
      expect(await storage.listParts('a')).toEqual([]);
    });
    expect((await store.list())[1]?.output.saved?.bytes).toBe(80 * SEGMENT_SIZE);
  });

  it('cancelling the only download deletes its data before the engine is closed', async () => {
    const { site, store, storage, coordinator, statuses, partsAtClose, engineOpen } = createPipeline(40);
    site.latencyFor = (url) => (url.includes('/seg-') ? 5 : 0);
    await store.add([{ task: task('a', 1), context: {} }]);
    await coordinator.pump();
    await vi.waitFor(
      async () => {
        expect((await store.list())[0]?.progress?.segmentsDone ?? 0).toBeGreaterThan(2);
      },
      { timeout: 5000, interval: 5 },
    );

    await coordinator.cancel(['a']);
    expect(await statuses()).toEqual(['cancelled']);
    expect(engineOpen()).toBe(false);
    // Nothing was left behind when the document went away.
    expect(partsAtClose).toEqual([{ a: 0 }]);
    expect(await storage.listParts('a')).toEqual([]);
  });
});

/**
 * Scenario "browser restarted during a download". One browser session is the
 * task store's local area (on disk, survives) plus a fresh session area, an
 * engine and a coordinator. Ending a session crashes its engine: no cleanup,
 * no further writes, as when Chrome closes. The next session starts on the
 * same chrome.storage.local and the same IndexedDB database.
 */
const PAGE = 'https://site.example/watch';

interface SessionOptions {
  local: FakeStorageArea;
  factory: IDBFactory;
  site: FakeMediaSite;
  /** Streams the popup would list in the open tabs. */
  streams?: () => DetectedStream[];
  /** The site answers 403 unless the task's request context carries the page as Referer. */
  requireReferer?: boolean;
}

function browserSession({ local, factory, site, streams = () => [], requireReferer = false }: SessionOptions) {
  const store = new TaskStore(local, new FakeStorageArea('session'));
  const dying = crashable(new SlowDeleteStorage(factory), site.fetch);
  // In Chrome the coordinator's DNR rule adds the Referer from session storage; here the fetch checks it.
  const fetchFor =
    (taskId: string): FetchFunction =>
    async (url, init) => {
      if (requireReferer && (await store.findContext(taskId))?.referer !== PAGE) return new Response('forbidden', { status: 403 });
      return dying.fetch(url, init);
    };
  let engineOpen = false;
  const coordinatorRef: { current?: DownloadCoordinator } = {};
  const reports: EngineReport[] = [];
  const files = new FakeFiles();
  files.onChanged = (id) => void coordinatorRef.current?.handleFileChange(id);
  const manager = new DownloadManager({
    storage: dying.storage,
    protocols: (taskId) => {
      const fetcher = new ManifestFetcher({ fetch: fetchFor(taskId) });
      return new ProtocolRegistry().register(new HlsAdapter({ fetcher })).register(new DashAdapter({ fetcher }));
    },
    fetchFor,
    freshSource: (taskId) => coordinatorRef.current?.freshSource(taskId) ?? Promise.resolve(null),
    releaseContexts: () => Promise.resolve(),
    report: (report) => {
      if (dying.isCrashed()) return;
      reports.push(report);
      void coordinatorRef.current?.handleReport(report);
    },
    reportIntervalMs: 0,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, maxRetryAfterMs: 2 },
  });
  const media = new MediaManager({
    storage: dying.storage,
    ffmpeg: fakeFfmpeg(),
    save: (request) => coordinatorRef.current?.startSave(request) ?? Promise.resolve(false),
    report: (report) => {
      if (!dying.isCrashed()) void coordinatorRef.current?.handleMediaReport(report);
    },
    reportIntervalMs: 0,
  });
  const offscreen = new Engine(manager, media);
  const engine: EngineChannel = {
    exists: () => Promise.resolve(engineOpen),
    ensure: () => {
      engineOpen = true;
      return Promise.resolve();
    },
    close: () => {
      engineOpen = false;
      return Promise.resolve();
    },
    sync: (work) => offscreen.sync(work),
    cancel: (ids) => offscreen.cancel(ids),
    reacquireContexts: () => Promise.resolve(),
  };
  const coordinator = new DownloadCoordinator({
    store,
    // The service worker's own handle on the same database.
    storage: new SlowDeleteStorage(factory),
    engine,
    acquireContext: () => Promise.resolve(() => Promise.resolve()),
    getSettings: () => Promise.resolve({ ...DEFAULT_SETTINGS, maxActiveTasks: 1, segmentConcurrency: 3 }),
    getStream: (tabId, streamId) => Promise.resolve(streams().find((stream) => stream.tabId === tabId && stream.id === streamId)),
    findStreams: (streamId) => Promise.resolve(streams().filter((stream) => stream.id === streamId)),
    files,
  });
  coordinatorRef.current = coordinator;
  return {
    store,
    coordinator,
    reports,
    files,
    /** Chrome closes: the engine dies where it is; reports in flight still land. */
    end: async () => {
      dying.crash();
      engineOpen = false;
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  };
}

/** Every progress the popup would have seen for one task, from the task store's change events (as useTasks merges them). */
function watchProgress(local: FakeStorageArea, taskId: string): (TaskProgress | undefined)[] {
  const seen: (TaskProgress | undefined)[] = [];
  const stored = { tasks: local.data.get(STORAGE_KEYS.tasks), progress: local.data.get(STORAGE_KEYS.taskProgress) };
  local.events.addListener((changes) => {
    const list = changes[STORAGE_KEYS.tasks];
    const progress = changes[STORAGE_KEYS.taskProgress];
    if (!list && !progress) return;
    if (list) stored.tasks = list.newValue;
    if (progress) stored.progress = progress.newValue;
    seen.push(mergeStoredTasks(stored.tasks, stored.progress).find((entry) => entry.id === taskId)?.progress);
  });
  return seen;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrays.reduce((sum, array) => sum + array.length, 0));
  let offset = 0;
  for (const array of arrays) {
    out.set(array, offset);
    offset += array.length;
  }
  return out;
}

function expectedTrack(path: string, count: number): Uint8Array {
  const out = new Uint8Array(count * SEGMENT_SIZE);
  for (let i = 0; i < count; i++) out.set(bodyFor(`${MOVIE_BASE}${path}/seg-${i}.ts`, SEGMENT_SIZE), i * SEGMENT_SIZE);
  return out;
}

describe('download pipeline across a browser restart', () => {
  it('resumes from the stored segments, shows them truthfully, and deletes orphaned data', async () => {
    const site = movieSite(30);
    site.latencyFor = (url) => (url.includes('/seg-') ? 3 : 0);
    const local = new FakeStorageArea('local');
    const factory = new IDBFactory();

    const before = browserSession({ local, factory, site });
    await before.store.add([{ task: task('a', 1), context: {} }]);
    await before.coordinator.pump();
    await until(async () => ((await before.store.list())[0]?.progress?.segmentsDone ?? 0) >= 12);
    await before.end();

    const storage = new IndexedDbSegmentStorage(factory);
    const kept = (await storage.inspectTask('a')).complete;
    expect(kept.length).toBeGreaterThanOrEqual(12);
    const keptUrls = kept.map((segment) => `${MOVIE_BASE}${segment.trackId === 'main' ? 'v720' : 'audio'}/seg-${segment.index}.ts`);
    const requested = new Map(keptUrls.map((url) => [url, site.count(url)]));
    // Left by a task removed while its cleanup could not finish.
    await storage.put({ taskId: 'ghost', trackId: 'main', index: 0, part: 0 }, new Blob(['orphan']));

    const seen = watchProgress(local, 'a');
    const after = browserSession({ local, factory, site });
    await after.coordinator.onStartup();
    await until(async () => settled((await after.store.list())[0]));

    // First what storage holds (no speed), then the engine's own figures: never back to 0.
    expect(seen[0]).toMatchObject({ segmentsDone: kept.length, segmentsTotal: 60, bytesPerSecond: 0, stale: true });
    expect(seen.every((progress) => (progress?.segmentsDone ?? 0) >= kept.length)).toBe(true);
    expect(after.reports[0]?.progress).toMatchObject({ segmentsDone: kept.length, resumedSegments: kept.length });
    expect((await after.store.list())[0]?.progress).toMatchObject({ segmentsDone: 60, percent: 100, bytes: 60 * SEGMENT_SIZE });

    for (const url of keptUrls) expect(site.count(url)).toBe(requested.get(url)); // not downloaded twice
    // Every segment, from both sessions, in order in the saved file; then the segments are deleted, the orphan too.
    expect(await after.files.bytesOf('Movie_a.mp4')).toEqual(concat(expectedTrack('v720', 30), expectedTrack('audio', 30)));
    await vi.waitFor(async () => {
      expect(await storage.taskIds()).toEqual([]);
    });
  });

  it('asks for the page when the lost Referer is needed, then resumes once the video plays again', async () => {
    const site = movieSite(20);
    site.latencyFor = (url) => (url.includes('/seg-') ? 3 : 0);
    const local = new FakeStorageArea('local');
    const factory = new IDBFactory();

    const before = browserSession({ local, factory, site, requireReferer: true });
    await before.store.add([{ task: task('a', 1), context: { referer: PAGE } }]);
    await before.coordinator.pump();
    await until(async () => ((await before.store.list())[0]?.progress?.segmentsDone ?? 0) >= 8);
    await before.end();
    const storage = new IndexedDbSegmentStorage(factory);
    const kept = (await storage.inspectTask('a')).complete.length;

    // New session: the Referer was in session storage and is gone; the page is not open yet.
    let streams: DetectedStream[] = [];
    const after = browserSession({ local, factory, site, requireReferer: true, streams: () => streams });
    await after.coordinator.onStartup();
    await until(async () => (await after.store.list())[0]?.status === 'failed');
    const failed = (await after.store.list())[0];
    expect(failed?.statusMessage).toBe(CONTEXT_LOST_MESSAGE);
    // The failed task still shows (and keeps) what it had stored.
    expect(failed?.progress).toMatchObject({ segmentsDone: kept });
    expect((await storage.inspectTask('a')).complete).toHaveLength(kept);

    // The user plays the video again (in a new tab): the popup lists it with the page as Referer.
    streams = [
      {
        id: 's1',
        tabId: 42,
        frameId: 0,
        protocol: 'hls',
        url: `${MOVIE_BASE}master.m3u8`,
        dedupeKey: `${MOVIE_BASE}master.m3u8`,
        evidence: ['extension'],
        status: 'ready',
        requestContext: { referer: PAGE },
        firstSeen: 2,
        lastSeen: 2,
      },
    ];
    const requestsBefore = site.count(`${MOVIE_BASE}v720/seg-0.ts`);
    await after.coordinator.retry(['a']);
    await until(async () => settled((await after.store.list())[0]));
    expect((await after.store.list())[0]?.source.tabId).toBe(42);
    expect(site.count(`${MOVIE_BASE}v720/seg-0.ts`)).toBe(requestsBefore);
    expect(await after.files.bytesOf('Movie_a.mp4')).toEqual(concat(expectedTrack('v720', 20), expectedTrack('audio', 20)));
  });
});
