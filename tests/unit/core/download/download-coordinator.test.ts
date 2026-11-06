import { describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_LOST_MESSAGE,
  DOWNLOADED_MESSAGE,
  DownloadCoordinator,
  saveFailureMessage,
  type CoordinatorDeps,
  type EngineChannel,
} from '@/core/download/download-coordinator';
import { EXPIRED_LINK_MESSAGE } from '@/core/download/download-manager';
import { containerMimeType } from '@/core/media/containers';
import type { SegmentStorage, StoredSummary } from '@/core/download/download-storage';
import { TaskStore } from '@/core/download/task-store';
import type { DetectedStream, RequestContext } from '@/core/models/detected-stream';
import type { DownloadTask, EngineTaskSpec, EngineWork, MediaProgress, MediaTaskSpec, TaskProgress } from '@/core/models/download-task';
import { DEFAULT_SETTINGS, type Settings } from '@/shared/settings/settings';
import { FakeStorageArea } from '@tests/fakes/fake-storage';
import { FakeFiles, FakeNotifier } from '@tests/fakes/fake-files';
import { ANALYSED_MEDIA, makeTask } from '@tests/fakes/tasks';

class FakeEngine implements EngineChannel {
  open = false;
  /** Downloads of each sync. */
  synced: EngineTaskSpec[][] = [];
  /** Media jobs of each sync. */
  mediaSynced: MediaTaskSpec[][] = [];
  cancelled: string[] = [];
  reacquired = 0;
  closed = 0;
  exists = () => Promise.resolve(this.open);
  ensure = () => {
    this.open = true;
    return Promise.resolve();
  };
  close = () => {
    this.open = false;
    this.closed += 1;
    return Promise.resolve();
  };
  sync = (work: EngineWork) => {
    this.synced.push(work.downloads);
    this.mediaSynced.push(work.media);
    return Promise.resolve([...work.downloads, ...work.media].map((task) => task.taskId));
  };
  cancel = (taskIds: string[]) => {
    this.cancelled.push(...taskIds);
    return Promise.resolve();
  };
  reacquireContexts = () => {
    this.reacquired += 1;
    return Promise.resolve();
  };
  get lastSync(): string[] {
    return (this.synced.at(-1) ?? []).map((task) => task.taskId);
  }
  get lastMediaSync(): string[] {
    return (this.mediaSynced.at(-1) ?? []).map((task) => task.taskId);
  }
}

const mediaProgress = (stage: MediaProgress['stage'], percent = 0): MediaProgress => ({ stage, step: 1, steps: 2, percent, startedAt: 1 });

const progress = (done: number, total = 10): TaskProgress => ({
  segmentsTotal: total,
  segmentsDone: done,
  bytes: done * 100,
  bytesPerSecond: 1000,
  percent: (done / total) * 100,
  retries: 0,
  startedAt: 1,
});

async function setup(
  tasks: { task: DownloadTask; context?: RequestContext }[],
  options: {
    settings?: Partial<Settings>;
    streams?: DetectedStream[];
    stored?: Record<string, StoredSummary>;
    /** Streams listed in other tabs (findStreams). */
    elsewhere?: DetectedStream[];
  } = {},
) {
  const store = new TaskStore(new FakeStorageArea('local'), new FakeStorageArea('session'));
  await store.add(tasks.map(({ task, context }) => ({ task, context: context ?? {} })));
  const engine = new FakeEngine();
  const deleted: string[] = [];
  /** What each task has stored, and the task IDs storage holds data for. */
  const stored = new Map<string, StoredSummary>(Object.entries(options.stored ?? {}));
  const storage = {
    deleteTask: (id: string) => {
      deleted.push(id);
      stored.delete(id);
      return Promise.resolve();
    },
    summary: (id: string) => Promise.resolve(stored.get(id)),
    taskIds: () => Promise.resolve([...stored.keys()]),
  } as unknown as SegmentStorage;
  const releases: string[] = [];
  const acquireContext = vi.fn(
    (url: string, _context: RequestContext): Promise<() => Promise<void>> =>
      Promise.resolve(() => {
        releases.push(url);
        return Promise.resolve();
      }),
  );
  let lease = 0;
  const files = new FakeFiles();
  const notifier = new FakeNotifier();
  const coordinator = new DownloadCoordinator({
    store,
    storage,
    engine,
    files,
    notifier,
    acquireContext,
    getSettings: () => Promise.resolve({ ...DEFAULT_SETTINGS, ...options.settings }),
    getStream: (tabId, streamId) =>
      Promise.resolve(options.streams?.find((stream) => stream.tabId === tabId && stream.id === streamId)),
    findStreams: (streamId) => Promise.resolve((options.elsewhere ?? []).filter((stream) => stream.id === streamId)),
    now: () => 5000,
    newLeaseId: () => `lease-${++lease}`,
  });
  const statusOf = async (id: string) => (await store.list()).find((task) => task.id === id)?.status;
  const taskOf = async (id: string) => (await store.list()).find((task) => task.id === id);
  return { store, engine, coordinator, deleted, releases, acquireContext, statusOf, taskOf, stored, files, notifier };
}

const queued = (id: string, createdAt: number) => ({ task: makeTask(id, { createdAt }) });

describe('DownloadCoordinator', () => {
  it('starts queued tasks oldest first, up to the simultaneous-downloads setting', async () => {
    const { coordinator, engine, statusOf } = await setup(
      [queued('c', 3), { ...queued('a', 1), context: { referer: 'https://site.example/' } }, queued('b', 2)],
      { settings: { maxActiveTasks: 2, segmentConcurrency: 9 } },
    );
    await coordinator.pump();
    expect(engine.open).toBe(true);
    expect(engine.lastSync).toEqual(['a', 'b']);
    expect(engine.synced.at(-1)?.[0]).toMatchObject({
      taskId: 'a',
      protocol: 'hls',
      context: { referer: 'https://site.example/' },
      variant: { id: 'video-0', height: 1080 },
      concurrency: 9,
    });
    expect([await statusOf('a'), await statusOf('b'), await statusOf('c')]).toEqual(['downloading', 'downloading', 'queued']);
  });

  it('records progress and outcomes, then starts the next queued task', async () => {
    const { coordinator, engine, store, statusOf } = await setup([queued('a', 1), queued('b', 2)], { settings: { maxActiveTasks: 1 } });
    await coordinator.pump();
    await coordinator.handleReport({ taskId: 'a', progress: progress(4) });
    expect((await store.list())[0]).toMatchObject({ status: 'downloading', progress: { segmentsDone: 4 }, updatedAt: 5000 });

    await coordinator.handleReport({ taskId: 'a', progress: progress(10), outcome: { status: 'downloaded' } });
    // Downloaded: FFmpeg merges it next, while the next download runs.
    expect((await store.list()).find((task) => task.id === 'a')).toMatchObject({
      status: 'processing',
      progress: { segmentsDone: 10 },
      processing: { stage: 'waiting' },
    });
    expect(await statusOf('b')).toBe('downloading');
    expect(engine.lastSync).toEqual(['b']);
    expect(engine.lastMediaSync).toEqual(['a']);
    expect(engine.mediaSynced.at(-1)).toEqual([{ taskId: 'a', job: 'process', format: 'auto', title: 'Movie' }]);

    await coordinator.handleReport({ taskId: 'b', progress: progress(3), outcome: { status: 'failed', message: 'HTTP 500' } });
    expect((await store.list()).find((task) => task.id === 'b')).toMatchObject({ status: 'failed', statusMessage: 'HTTP 500' });
    expect(engine.open).toBe(true); // FFmpeg still works on 'a'

    await coordinator.startSave({ taskId: 'a', url: URL.createObjectURL(new Blob(['file'])), container: 'mp4', size: 4, media: ANALYSED_MEDIA });
    await coordinator.pump();
    expect((await store.list()).find((task) => task.id === 'a')).toMatchObject({ status: 'completed', media: ANALYSED_MEDIA });
    expect(engine.open).toBe(false); // nothing left to do
  });

  it('ignores late reports for tasks that are no longer running', async () => {
    const { coordinator, store } = await setup([{ task: makeTask('a', { status: 'cancelled' }) }]);
    await coordinator.handleReport({ taskId: 'a', progress: progress(9), outcome: { status: 'downloaded' } });
    expect((await store.list())[0]).toMatchObject({ status: 'cancelled' });
    expect((await store.list())[0]?.progress).toBeUndefined();
  });

  it('cancels queued, running and downloaded tasks appropriately', async () => {
    const { coordinator, engine, deleted, statusOf } = await setup([
      { task: makeTask('q') },
      { task: makeTask('run', { status: 'downloading' }) },
      { task: makeTask('done', { status: 'downloaded' }) },
      { task: makeTask('failed', { status: 'failed' }) },
    ]);
    engine.open = true;
    await expect(coordinator.cancel(['q', 'run', 'done', 'failed'])).resolves.toBe(3);
    expect([await statusOf('q'), await statusOf('run'), await statusOf('done'), await statusOf('failed')]).toEqual([
      'cancelled',
      'cancelled',
      'cancelled',
      'failed',
    ]);
    expect(engine.cancelled).toEqual(['run']);
    expect(deleted.sort()).toEqual(['done', 'q']);
  });

  it('retries failed and cancelled tasks (from the start when nothing is stored)', async () => {
    const { coordinator, engine, store } = await setup([
      { task: makeTask('f', { status: 'failed', statusMessage: 'HTTP 500', progress: progress(3) }) },
      { task: makeTask('ok', { status: 'downloaded' }) },
    ]);
    await expect(coordinator.retry(['f', 'ok'])).resolves.toBe(1);
    const task = (await store.list()).find((candidate) => candidate.id === 'f');
    expect(task).toMatchObject({ status: 'downloading' });
    expect(task?.statusMessage).toBeUndefined();
    expect(task?.progress).toBeUndefined();
    expect(engine.lastSync).toEqual(['f']);
  });

  describe('scenario: popup closed or service worker restarted during download', () => {
    it('re-acquires header rules in a running engine and re-syncs its tasks', async () => {
      const { coordinator, engine } = await setup([{ task: makeTask('run', { status: 'downloading' }) }]);
      engine.open = true;
      await coordinator.onStartup();
      expect(engine.reacquired).toBe(1);
      expect(engine.lastSync).toEqual(['run']);
    });

    it('restarts the engine for tasks interrupted by a browser restart', async () => {
      const { coordinator, engine } = await setup([{ task: makeTask('run', { status: 'downloading' }) }, queued('next', 9)], {
        settings: { maxActiveTasks: 1 },
      });
      await coordinator.onStartup();
      expect(engine.reacquired).toBe(0);
      expect(engine.open).toBe(true);
      expect(engine.lastSync).toEqual(['run']);
    });
  });

  it('closes the engine when there is no work', async () => {
    const { coordinator, engine } = await setup([{ task: makeTask('done', { status: 'completed' }) }]);
    engine.open = true;
    await coordinator.pump();
    expect(engine.closed).toBe(1);
    expect(engine.synced).toEqual([[]]);
    expect(engine.mediaSynced).toEqual([[]]);
  });

  describe('media processing and saving (Phases 8–9)', () => {
    /** What the engine sends once a file is merged: a blob: URL Node can resolve, like Chrome. */
    const saveRequest = (taskId: string, container: 'mp4' | 'mkv' = 'mp4') => ({
      taskId,
      url: URL.createObjectURL(new Blob(['merged file'], { type: containerMimeType(container) })),
      container,
      size: 11,
      media: { ...ANALYSED_MEDIA, container },
    });

    it('hands downloaded tasks to FFmpeg one at a time, oldest first, alongside downloads', async () => {
      const { coordinator, engine, statusOf, taskOf } = await setup([
        { task: makeTask('d2', { status: 'downloaded', createdAt: 2, statusMessage: DOWNLOADED_MESSAGE }) },
        { task: makeTask('d1', { status: 'downloaded', createdAt: 1, output: { baseName: 'One', format: 'mkv' } }) },
        { task: makeTask('done', { status: 'completed' }) },
        queued('q', 3),
      ]);
      await coordinator.pump();
      expect([await statusOf('d1'), await statusOf('d2'), await statusOf('done'), await statusOf('q')]).toEqual([
        'processing',
        'downloaded',
        'completed',
        'downloading',
      ]);
      expect(await taskOf('d1')).toMatchObject({ processing: { stage: 'waiting', percent: 0 } });
      expect((await taskOf('d1'))?.statusMessage).toBeUndefined();
      expect(engine.mediaSynced.at(-1)).toEqual([{ taskId: 'd1', job: 'process', format: 'mkv', title: 'Movie' }]);
      expect(engine.lastSync).toEqual(['q']);

      await coordinator.handleMediaReport({ taskId: 'd1', progress: mediaProgress('merging', 40) });
      expect(await taskOf('d1')).toMatchObject({ status: 'processing', processing: { stage: 'merging', percent: 40 } });
      await coordinator.handleMediaReport({ taskId: 'd1', progress: mediaProgress('merging'), outcome: { status: 'failed', message: 'FFmpeg crashed' } });
      expect(await statusOf('d2')).toBe('processing');
      expect(engine.lastMediaSync).toEqual(['d2']);
    });

    it('has Chrome save the merged file, then completes the task, deletes its segments and says so', async () => {
      const { coordinator, engine, files, notifier, deleted, taskOf } = await setup([
        { task: makeTask('a', { status: 'processing', processing: mediaProgress('saving', 97), progress: progress(10) }) },
      ]);
      files.manual = true;
      engine.open = true;
      const request = saveRequest('a');
      await expect(coordinator.startSave(request)).resolves.toBe(true);
      expect(files.entries.get(1)).toMatchObject({ url: request.url, path: '/Downloads/Movie_a.mp4', state: 'in_progress' });
      expect(await taskOf('a')).toMatchObject({ status: 'processing', media: request.media, output: { downloadId: 1 }, processing: { stage: 'saving' } });
      // A late progress report of the engine does not undo "saving".
      await coordinator.handleMediaReport({ taskId: 'a', progress: mediaProgress('verifying', 95) });
      expect((await taskOf('a'))?.processing?.stage).toBe('saving');

      files.finish(1);
      await coordinator.handleFileChange(1);
      await coordinator.pump();
      const task = await taskOf('a');
      expect(task).toMatchObject({ status: 'completed', output: { downloadId: 1, saved: { path: '/Downloads/Movie_a.mp4', bytes: 11, savedAt: 5000 } } });
      expect(task?.processing).toBeUndefined();
      expect(deleted).toEqual(['a']);
      expect(notifier.shown).toEqual([{ kind: 'completed', taskId: 'a' }]);
      // Nothing left: the engine (and the blob: URL in it) goes.
      expect(engine.mediaSynced.at(-1)).toEqual([]);
      expect(engine.open).toBe(false);
      // Chrome's change event arriving twice changes nothing.
      await coordinator.handleFileChange(1);
      expect(notifier.shown).toHaveLength(1);
    });

    it('finishes a save that Chrome completed before startSave returned', async () => {
      const { coordinator, files, taskOf } = await setup([{ task: makeTask('fast', { status: 'processing', processing: mediaProgress('saving') }) }]);
      await expect(coordinator.startSave(saveRequest('fast', 'mkv'))).resolves.toBe(true);
      expect(files.entries.get(1)?.path).toBe('/Downloads/Movie_fast.mkv');
      expect(await taskOf('fast')).toMatchObject({ status: 'completed', output: { saved: { path: '/Downloads/Movie_fast.mkv' } } });
    });

    it('fails with Chrome’s reason when saving is interrupted, keeping the segments', async () => {
      const { coordinator, files, notifier, deleted, taskOf } = await setup([{ task: makeTask('i', { status: 'processing', processing: mediaProgress('saving') }) }]);
      files.manual = true;
      await coordinator.startSave(saveRequest('i'));
      files.finish(1, 'FILE_NO_SPACE');
      await coordinator.handleFileChange(1);
      expect(await taskOf('i')).toMatchObject({ status: 'failed', statusMessage: saveFailureMessage('FILE_NO_SPACE') });
      expect(deleted).toEqual([]);
      expect(notifier.shown).toEqual([{ kind: 'failed', taskId: 'i' }]);
    });

    it('fails the task when Chrome refuses the download, and tells the engine to let go', async () => {
      const { coordinator, files, taskOf } = await setup([{ task: makeTask('r', { status: 'processing', processing: mediaProgress('saving') }) }]);
      files.refuse = 'Invalid filename';
      await expect(coordinator.startSave(saveRequest('r'))).resolves.toBe(false);
      expect(await taskOf('r')).toMatchObject({ status: 'failed', statusMessage: expect.stringContaining('Chrome could not save the file: Invalid filename') as string });
    });

    it('refuses files of tasks that are no longer processing', async () => {
      const { coordinator, files } = await setup([{ task: makeTask('c', { status: 'cancelled' }) }]);
      await expect(coordinator.startSave(saveRequest('c'))).resolves.toBe(false);
      expect(files.entries.size).toBe(0);
    });

    it('cancelling while Chrome saves stops the save and the engine', async () => {
      const { coordinator, engine, files, taskOf } = await setup([{ task: makeTask('s', { status: 'processing', processing: mediaProgress('saving') }) }]);
      files.manual = true;
      engine.open = true;
      await coordinator.startSave(saveRequest('s'));
      await coordinator.cancel(['s']);
      expect(files.cancelled).toEqual([1]);
      expect(engine.cancelled).toEqual(['s']);
      expect((await taskOf('s'))?.output.downloadId).toBeUndefined();
    });

    it('a new save of the same task abandons the earlier one (the engine restarted while saving)', async () => {
      const { coordinator, files } = await setup([{ task: makeTask('twice', { status: 'processing', processing: mediaProgress('saving') }) }]);
      files.manual = true;
      await coordinator.startSave(saveRequest('twice'));
      await coordinator.startSave(saveRequest('twice'));
      expect(files.cancelled).toEqual([1]);
      expect(files.entries.get(2)?.path).toBe('/Downloads/Movie_twice.mp4');
    });

    it('keeps the segments of a failed analysis or merge, unless the engine discarded them', async () => {
      const { coordinator, notifier, taskOf } = await setup([
        { task: makeTask('a', { status: 'processing', progress: progress(10), processing: mediaProgress('analysing') }) },
        { task: makeTask('b', { status: 'processing', progress: progress(10), processing: mediaProgress('analysing') }) },
      ]);
      await coordinator.handleMediaReport({ taskId: 'a', progress: mediaProgress('merging'), outcome: { status: 'failed', message: 'FFmpeg crashed' } });
      expect(await taskOf('a')).toMatchObject({ status: 'failed', statusMessage: 'FFmpeg crashed', progress: { segmentsDone: 10 } });
      expect((await taskOf('a'))?.processing).toBeUndefined();

      await coordinator.handleMediaReport({
        taskId: 'b',
        progress: mediaProgress('analysing'),
        outcome: { status: 'failed', message: 'Not media', discardedData: true },
      });
      expect(await taskOf('b')).toMatchObject({ status: 'failed', statusMessage: 'Not media' });
      expect((await taskOf('b'))?.progress).toBeUndefined();
      expect(notifier.shown).toEqual([
        { kind: 'failed', taskId: 'a' },
        { kind: 'failed', taskId: 'b' },
      ]);
    });

    it('cancels processing through the engine and ignores its late reports', async () => {
      const { coordinator, engine, deleted, taskOf, notifier } = await setup([
        { task: makeTask('p', { status: 'processing', processing: mediaProgress('analysing'), progress: progress(10) }) },
      ]);
      engine.open = true;
      await expect(coordinator.cancel(['p'])).resolves.toBe(1);
      expect(engine.cancelled).toEqual(['p']); // the engine stops FFmpeg and deletes the data
      expect(deleted).toEqual([]);
      const task = await taskOf('p');
      expect(task?.status).toBe('cancelled');
      expect(task?.processing).toBeUndefined();
      expect(task?.progress).toBeUndefined();

      await coordinator.handleMediaReport({ taskId: 'p', progress: mediaProgress('merging', 50), outcome: { status: 'failed', message: 'late' } });
      expect(await taskOf('p')).toMatchObject({ status: 'cancelled' });
      expect(notifier.shown).toEqual([]);
    });

    it('retries a failed task through a new download run, dropping what the last run produced', async () => {
      const { coordinator, taskOf } = await setup([
        {
          task: makeTask('f', {
            status: 'failed',
            statusMessage: 'FFmpeg crashed',
            media: ANALYSED_MEDIA,
            progress: progress(10),
            output: { baseName: 'Movie_f', format: 'auto', downloadId: 4 },
          }),
        },
      ]);
      await coordinator.retry(['f']);
      const task = await taskOf('f');
      expect(task?.status).toBe('downloading');
      expect(task?.media).toBeUndefined();
      expect(task?.output).toEqual({ baseName: 'Movie_f', format: 'auto' });
    });

    it('after a browser restart, processes interrupted tasks again; a running engine keeps its job', async () => {
      const interrupted = await setup([{ task: makeTask('p', { status: 'processing', processing: mediaProgress('merging', 50) }) }]);
      await interrupted.coordinator.onStartup();
      expect(interrupted.engine.lastMediaSync).toEqual(['p']);
      expect(await interrupted.taskOf('p')).toMatchObject({ status: 'processing', processing: { stage: 'waiting', percent: 0 } });

      const alive = await setup([{ task: makeTask('p', { status: 'processing', processing: mediaProgress('merging', 50) }) }]);
      alive.engine.open = true;
      await alive.coordinator.onStartup();
      expect(alive.engine.lastMediaSync).toEqual(['p']);
      expect(await alive.taskOf('p')).toMatchObject({ status: 'processing', processing: { stage: 'merging', percent: 50 } });
    });

    it('on startup, completes saves Chrome finished while the service worker was not running', async () => {
      const { coordinator, files, taskOf, deleted } = await setup([
        { task: makeTask('done', { status: 'processing', processing: mediaProgress('saving'), output: { baseName: 'Movie_done', format: 'auto', downloadId: 1 } }) },
      ]);
      files.entries.set(1, { state: 'complete', path: '/Downloads/Movie_done.mp4', bytes: 99, url: 'blob:x' });
      await coordinator.onStartup();
      expect(await taskOf('done')).toMatchObject({ status: 'completed', output: { saved: { path: '/Downloads/Movie_done.mp4', bytes: 99 } } });
      expect(deleted).toContain('done');
    });

    it('clears completed tasks from the Queue tab only', async () => {
      const { coordinator, taskOf } = await setup([{ task: makeTask('c', { status: 'completed' }) }, { task: makeTask('q') }]);
      await expect(coordinator.dismiss(['c', 'q'])).resolves.toBe(1);
      expect((await taskOf('c'))?.dismissed).toBe(true);
      expect((await taskOf('q'))?.dismissed).toBeUndefined();
    });

    it('notifies when a download fails', async () => {
      const { coordinator, notifier } = await setup([queued('a', 1)]);
      await coordinator.pump();
      await coordinator.handleReport({ taskId: 'a', progress: progress(3), outcome: { status: 'failed', message: 'HTTP 500' } });
      expect(notifier.shown).toEqual([{ kind: 'failed', taskId: 'a' }]);
    });
  });

  it('leases header rules with the task context, and none without one', async () => {
    const { coordinator, acquireContext, releases } = await setup([
      { task: makeTask('ctx', { status: 'downloading' }), context: { referer: 'https://site.example/' } },
      { task: makeTask('none', { status: 'downloading' }) },
    ]);
    await expect(coordinator.acquireContext('none', 'https://cdn.example.com/a.ts')).resolves.toBeNull();
    const lease = await coordinator.acquireContext('ctx', 'https://cdn.example.com/a.ts');
    expect(lease).toBe('lease-1');
    expect(acquireContext).toHaveBeenCalledWith('https://cdn.example.com/a.ts', { referer: 'https://site.example/' });
    await coordinator.releaseContext(lease ?? '');
    await coordinator.releaseContext('unknown');
    expect(releases).toEqual(['https://cdn.example.com/a.ts']);
  });

  it('drops a rule granted after its task was cancelled while waiting for it', async () => {
    const { coordinator, acquireContext, releases } = await setup([
      { task: makeTask('t', { status: 'downloading' }), context: { referer: 'https://site.example/' } },
    ]);
    // The host's rule is busy with another context: the grant comes later.
    let grant: () => void = () => undefined;
    acquireContext.mockImplementationOnce(
      (url: string) =>
        new Promise((resolve) => {
          grant = () => {
            resolve(() => {
              releases.push(url);
              return Promise.resolve();
            });
          };
        }),
    );
    const lease = coordinator.acquireContext('t', 'https://cdn.example.com/a.ts');
    await vi.waitFor(() => {
      expect(acquireContext).toHaveBeenCalled();
    });
    await coordinator.cancel(['t']);
    grant();
    await expect(lease).resolves.toBeNull();
    expect(releases).toEqual(['https://cdn.example.com/a.ts']);
  });

  it('releases every remaining rule when it closes the engine', async () => {
    const { coordinator, engine, store, releases } = await setup([
      { task: makeTask('t', { status: 'downloading' }), context: { referer: 'https://site.example/' } },
    ]);
    engine.open = true;
    await coordinator.acquireContext('t', 'https://cdn.example.com/a.ts');
    await coordinator.acquireContext('t', 'https://cdn2.example.com/a.ts');
    // The engine stopped before it could hand its leases back (e.g. its cleanup timed out).
    await store.update('t', (task) => ({ ...task, status: 'failed' }));
    await coordinator.pump();
    expect(engine.closed).toBe(1);
    expect(releases.sort()).toEqual(['https://cdn.example.com/a.ts', 'https://cdn2.example.com/a.ts']);
  });

  it('offers the freshest link of the same video and stores its context', async () => {
    const stream = {
      id: 's1',
      tabId: 3,
      url: 'https://cdn.example.com/master.m3u8?token=fresh',
      requestContext: { referer: 'https://site.example/again' },
    } as DetectedStream;
    const { coordinator, store } = await setup([{ task: makeTask('t') }, { task: makeTask('other', { source: { ...makeTask('x').source, streamId: 'zzz' } }) }], {
      streams: [stream],
    });
    await expect(coordinator.freshSource('t')).resolves.toEqual({
      manifestUrl: 'https://cdn.example.com/master.m3u8?token=fresh',
      context: { referer: 'https://site.example/again' },
    });
    expect(await store.getContext('t')).toEqual({ referer: 'https://site.example/again' });
    expect((await store.list())[0]?.source.manifestUrl).toBe('https://cdn.example.com/master.m3u8?token=fresh');
    await expect(coordinator.freshSource('other')).resolves.toBeNull();
    await expect(coordinator.freshSource('missing')).resolves.toBeNull();
  });

  it('deletes stored segments of removed tasks', async () => {
    const { coordinator, deleted } = await setup([]);
    await coordinator.afterRemove(['a', 'b']);
    expect(deleted).toEqual(['a', 'b']);
  });

  describe('resume and recovery (Phase 7)', () => {
    const kept = (segmentsDone: number, segmentsTotal = 10): StoredSummary => ({ segmentsTotal, segmentsDone, bytes: segmentsDone * 100 });
    const stream = (overrides: Partial<DetectedStream>) =>
      ({
        id: 's1',
        tabId: 3,
        url: 'https://cdn.example.com/master.m3u8?token=fresh',
        requestContext: { referer: 'https://site.example/watch' },
        lastSeen: 1,
        ...overrides,
      }) as DetectedStream;

    /** A browser restart: tasks stay on disk, session storage (with every request context) starts empty. */
    async function restarted(tasks: DownloadTask[], deps: Partial<CoordinatorDeps> = {}) {
      const local = new FakeStorageArea('local');
      await new TaskStore(local, new FakeStorageArea('session')).add(tasks.map((task) => ({ task, context: { referer: 'https://site.example/' } })));
      const store = new TaskStore(local, new FakeStorageArea('session'));
      const engine = new FakeEngine();
      const coordinator = new DownloadCoordinator({
        store,
        storage: { summary: () => Promise.resolve(undefined), taskIds: () => Promise.resolve([]) } as unknown as SegmentStorage,
        engine,
        acquireContext: () => Promise.resolve(() => Promise.resolve()),
        getSettings: () => Promise.resolve(DEFAULT_SETTINGS),
        getStream: () => Promise.resolve(undefined),
        findStreams: () => Promise.resolve([]),
        ...deps,
      });
      return { store, engine, coordinator };
    }

    it('shows what a failed task keeps while it waits after Retry, until the engine reports', async () => {
      const { coordinator, store, engine, taskOf } = await setup(
        [
          { task: makeTask('f', { status: 'failed', statusMessage: 'HTTP 500', progress: progress(4) }) },
          { task: makeTask('busy', { status: 'downloading' }) },
        ],
        { settings: { maxActiveTasks: 1 }, stored: { f: kept(4) } },
      );
      await coordinator.retry(['f']);
      const waiting = await taskOf('f');
      expect(waiting).toMatchObject({
        status: 'queued',
        progress: { segmentsDone: 4, segmentsTotal: 10, percent: 40, bytesPerSecond: 0, stale: true },
      });
      expect(waiting?.statusMessage).toBeUndefined();

      await store.update('busy', (task) => ({ ...task, status: 'downloaded' }));
      await coordinator.pump();
      expect(await taskOf('f')).toMatchObject({ status: 'downloading', progress: { segmentsDone: 4, stale: true } });
      expect(engine.lastSync).toEqual(['f']);
      await coordinator.handleReport({ taskId: 'f', progress: { ...progress(5), resumedSegments: 4 } });
      expect((await taskOf('f'))?.progress).toEqual({ ...progress(5), resumedSegments: 4 });
    });

    it('retries from the start when nothing is stored, and drops the progress of cancelled tasks', async () => {
      const { coordinator, taskOf } = await setup([{ task: makeTask('run', { status: 'downloading', progress: progress(6) }) }]);
      await coordinator.cancel(['run']);
      expect((await taskOf('run'))?.progress).toBeUndefined(); // its data is deleted
      await coordinator.retry(['run']);
      expect((await taskOf('run'))?.progress).toBeUndefined();
    });

    it('after a browser restart, shows what interrupted downloads stored and resumes them', async () => {
      const { coordinator, engine, taskOf } = await setup(
        [
          { task: makeTask('a', { status: 'downloading', progress: { ...progress(7), bytesPerSecond: 5000 } }) },
          { task: makeTask('b', { status: 'downloading', progress: progress(1) }) },
        ],
        { stored: { a: kept(6) } },
      );
      await coordinator.onStartup();
      // What storage holds (the last report may be ahead of it), and no stale speed.
      expect((await taskOf('a'))?.progress).toMatchObject({ segmentsDone: 6, bytesPerSecond: 0, stale: true });
      expect((await taskOf('b'))?.progress).toBeUndefined();
      expect(engine.lastSync).toEqual(['a', 'b']);
    });

    it('leaves running downloads alone when only the service worker restarted', async () => {
      const { coordinator, engine, taskOf } = await setup([{ task: makeTask('a', { status: 'downloading', progress: progress(7) }) }], {
        stored: { a: kept(6) },
      });
      engine.open = true;
      await coordinator.onStartup();
      expect((await taskOf('a'))?.progress).toEqual(progress(7));
    });

    it('takes a request context lost in a restart from the video playing in another tab', async () => {
      const task = makeTask('t', { status: 'downloading', source: { ...makeTask('t').source, manifestUrl: 'https://cdn.example.com/master.m3u8?token=old' } });
      const { coordinator, engine, store } = await restarted([task], {
        findStreams: (streamId) =>
          Promise.resolve(
            [stream({ tabId: 8, lastSeen: 1 }), stream({ tabId: 9, lastSeen: 5, requestContext: { referer: 'https://site.example/newest' } })].filter(
              (candidate) => candidate.id === streamId,
            ),
          ),
      });
      await coordinator.onStartup();
      expect(engine.synced.at(-1)?.[0]).toMatchObject({
        manifestUrl: 'https://cdn.example.com/master.m3u8?token=fresh',
        context: { referer: 'https://site.example/newest' },
      });
      expect((await store.list())[0]?.source).toMatchObject({ tabId: 9, manifestUrl: 'https://cdn.example.com/master.m3u8?token=fresh' });
      expect(await store.findContext('t')).toEqual({ referer: 'https://site.example/newest' });
    });

    it('tries the stored link without a context when the video is open nowhere, and names the restart if that fails', async () => {
      const { coordinator, engine, store } = await restarted([makeTask('t', { status: 'downloading' })]);
      await coordinator.onStartup();
      expect(engine.synced.at(-1)?.[0]).toMatchObject({ manifestUrl: 'https://cdn.example.com/master.m3u8', context: {} });

      await coordinator.handleReport({
        taskId: 't',
        progress: progress(3),
        outcome: { status: 'failed', message: EXPIRED_LINK_MESSAGE, reason: 'expired' },
      });
      expect((await store.list())[0]).toMatchObject({ status: 'failed', statusMessage: CONTEXT_LOST_MESSAGE });
    });

    it('keeps the engine message for an expired link when the context is still known', async () => {
      const { coordinator, taskOf } = await setup([{ task: makeTask('t', { status: 'downloading' }), context: { referer: 'https://site.example/' } }]);
      await coordinator.handleReport({
        taskId: 't',
        progress: progress(3),
        outcome: { status: 'failed', message: EXPIRED_LINK_MESSAGE, reason: 'expired' },
      });
      expect(await taskOf('t')).toMatchObject({ status: 'failed', statusMessage: EXPIRED_LINK_MESSAGE });
    });

    it('finds a fresh link in another tab when the task tab no longer lists the video', async () => {
      const { coordinator, store } = await setup([{ task: makeTask('t', { status: 'downloading' }) }], {
        elsewhere: [stream({ tabId: 12, url: 'https://cdn.example.com/other.m3u8' }), stream({ tabId: 14 })],
      });
      await expect(coordinator.freshSource('t')).resolves.toEqual({
        manifestUrl: 'https://cdn.example.com/master.m3u8?token=fresh',
        context: { referer: 'https://site.example/watch' },
      });
      expect((await store.list())[0]?.source.tabId).toBe(14);
    });

    it('deletes data no task needs: removed, cancelled and completed tasks', async () => {
      const { coordinator, deleted } = await setup(
        [
          { task: makeTask('queued') },
          { task: makeTask('running', { status: 'downloading' }) },
          { task: makeTask('downloaded', { status: 'downloaded' }) },
          { task: makeTask('failed', { status: 'failed' }) },
          { task: makeTask('cancelled', { status: 'cancelled' }) },
          { task: makeTask('completed', { status: 'completed' }) },
        ],
        {
          stored: Object.fromEntries(
            ['queued', 'running', 'downloaded', 'failed', 'cancelled', 'completed', 'removed'].map((id) => [id, kept(1)]),
          ),
        },
      );
      await expect(coordinator.cleanup()).resolves.toEqual(['cancelled', 'completed', 'removed']);
      expect(deleted).toEqual(['cancelled', 'completed', 'removed']);
    });

    it('cleans up on startup and whenever the engine closes', async () => {
      const { coordinator, store, deleted, stored } = await setup([{ task: makeTask('a', { status: 'downloading' }) }], {
        stored: { ghost: kept(2), a: kept(1) },
      });
      await coordinator.onStartup();
      expect(deleted).toEqual(['ghost']);
      // A cancel whose cleanup timed out left data behind; the next idle pump removes it.
      await store.update('a', (task) => ({ ...task, status: 'cancelled' }));
      stored.set('a', kept(1));
      await coordinator.pump();
      expect(deleted).toEqual(['ghost', 'a']);
    });
  });
});
