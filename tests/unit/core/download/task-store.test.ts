import { describe, expect, it } from 'vitest';
import { MAX_STORED_TASKS, parseStoredTasks, TaskStore } from '@/core/download/task-store';
import { STORAGE_KEYS } from '@/shared/constants';
import { FakeStorageArea } from '@tests/fakes/fake-storage';
import { ANALYSED_MEDIA, makeTask } from '@tests/fakes/tasks';

function setup() {
  const local = new FakeStorageArea('local');
  const session = new FakeStorageArea('session');
  return { local, session, store: new TaskStore(local, session) };
}

describe('TaskStore', () => {
  it('stores tasks in local storage and their request context only in session storage', async () => {
    const { local, session, store } = setup();
    await store.add([{ task: makeTask('t1'), context: { referer: 'https://site.example/watch' } }]);
    expect(await store.list()).toEqual([makeTask('t1')]);
    expect(JSON.stringify(local.data.get(STORAGE_KEYS.tasks))).not.toContain('site.example');
    expect(session.data.get(STORAGE_KEYS.taskContexts)).toEqual({ t1: { referer: 'https://site.example/watch' } });
    expect(await store.getContext('t1')).toEqual({ referer: 'https://site.example/watch' });
    expect(await store.getContext('unknown')).toEqual({});
  });

  it('tells a context lost with the browser session apart from an empty one', async () => {
    const { local, store } = setup();
    await store.add([{ task: makeTask('t1'), context: {} }]);
    expect(await store.findContext('t1')).toEqual({});
    // After a browser restart: same local area, empty session area.
    const restarted = new TaskStore(local, new FakeStorageArea('session'));
    expect(await restarted.findContext('t1')).toBeUndefined();
    expect(await restarted.getContext('t1')).toEqual({});
  });

  it('keeps the resume details of a task\'s progress', async () => {
    const { store } = setup();
    const progress = { segmentsTotal: 10, segmentsDone: 4, bytes: 400, bytesPerSecond: 0, percent: 40, retries: 0, startedAt: 1 };
    await store.add([
      { task: makeTask('carried', { progress: { ...progress, stale: true } }), context: {} },
      { task: makeTask('resumed', { status: 'downloading', progress: { ...progress, resumedSegments: 3 } }), context: {} },
    ]);
    const [carried, resumed] = await store.list();
    expect(carried?.progress).toEqual({ ...progress, stale: true });
    expect(resumed?.progress).toEqual({ ...progress, resumedSegments: 3 });
  });

  it('updates and removes tasks (with their contexts)', async () => {
    const { session, store } = setup();
    await store.add([
      { task: makeTask('t1'), context: {} },
      { task: makeTask('t2'), context: { origin: 'https://site.example' } },
    ]);
    const updated = await store.update('t1', (task) => ({ ...task, status: 'cancelled', updatedAt: 5 }));
    expect(updated).toMatchObject({ status: 'cancelled', updatedAt: 5 });
    await expect(store.update('missing', (task) => task)).resolves.toBeUndefined();
    await expect(store.remove(['t2', 'missing'])).resolves.toBe(1);
    expect((await store.list()).map((task) => task.id)).toEqual(['t1']);
    expect(session.data.get(STORAGE_KEYS.taskContexts)).toEqual({ t1: {} });
  });

  it('serialises concurrent writes so no task is lost', async () => {
    const { store } = setup();
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => store.add([{ task: makeTask(id), context: {} }])));
    expect((await store.list()).map((task) => task.id).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops the oldest finished tasks beyond the cap, never active ones', async () => {
    const { store } = setup();
    const finished = Array.from({ length: MAX_STORED_TASKS }, (_, i) => ({
      task: makeTask(`done-${i}`, { status: 'completed' }),
      context: {},
    }));
    await store.add(finished);
    await store.add([{ task: makeTask('new'), context: {} }]);
    const ids = (await store.list()).map((task) => task.id);
    expect(ids).toHaveLength(MAX_STORED_TASKS);
    expect(ids).not.toContain('done-0');
    expect(ids).toContain('new');
  });
});

describe('parseStoredTasks', () => {
  it('drops malformed tasks and unknown values', () => {
    const tasks = parseStoredTasks({
      version: 1,
      tasks: [makeTask('ok'), { ...makeTask('bad-status'), status: 'exploded' }, { ...makeTask('no-source'), source: null }, 7],
    });
    expect(tasks.map((task) => task.id)).toEqual(['ok']);
    expect(parseStoredTasks({ version: 2, tasks: [] })).toEqual([]);
    expect(parseStoredTasks(undefined)).toEqual([]);
  });

  it('keeps media processing progress and analyses, and drops damaged ones', async () => {
    const { local, store } = setup();
    const processing = { stage: 'analysing' as const, step: 2, steps: 2, percent: 50, startedAt: 1, detail: 'English' };
    await store.add([
      { task: makeTask('p', { status: 'processing', processing }), context: {} },
      { task: makeTask('d', { status: 'downloaded', media: ANALYSED_MEDIA }), context: {} },
    ]);
    expect(await store.list()).toEqual([
      makeTask('p', { status: 'processing', processing }),
      makeTask('d', { status: 'downloaded', media: ANALYSED_MEDIA }),
    ]);
    const stored = local.data.get(STORAGE_KEYS.tasks) as { tasks: Record<string, unknown>[] };
    stored.tasks[1] = { ...stored.tasks[1], media: { ...ANALYSED_MEDIA, container: 'avi' } };
    expect((await store.list())[1]?.media).toBeUndefined();
  });

  it('keeps where a completed video was saved, and whether it was cleared from the queue', async () => {
    const { store } = setup();
    const task = makeTask('c', {
      status: 'completed',
      dismissed: true,
      output: { baseName: 'Movie', format: 'mkv', downloadId: 7, saved: { path: '/Downloads/Movie.mkv', bytes: 1234, savedAt: 9 } },
    });
    await store.add([{ task, context: {} }]);
    expect(await store.list()).toEqual([task]);
  });

  it('writes only the small progress key while a task reports progress', async () => {
    const { local, store } = setup();
    const done = Array.from({ length: 300 }, (_, i) => makeTask(`done-${i}`, { status: 'completed', media: ANALYSED_MEDIA }));
    await store.add([...done.map((task) => ({ task, context: {} })), { task: makeTask('run', { status: 'downloading' }), context: {} }]);
    local.writeCount = 0;
    local.bytesWritten = 0;
    const progress = { segmentsTotal: 100, segmentsDone: 1, bytes: 1, bytesPerSecond: 1, percent: 1, retries: 0, startedAt: 1 };
    for (let i = 1; i <= 10; i++) await store.update('run', (task) => ({ ...task, progress: { ...progress, segmentsDone: i }, updatedAt: 100 + i }));
    expect(local.writeCount).toBe(10);
    // 300 tasks with media details are hundreds of KB; a progress write is a few hundred bytes.
    expect(local.bytesWritten / local.writeCount).toBeLessThan(1024);
    const run = (await store.list()).find((task) => task.id === 'run');
    expect(run).toMatchObject({ progress: { segmentsDone: 10 }, updatedAt: 110 });

    // A status change rewrites the list, without the progress inside it.
    await store.update('run', (task) => ({ ...task, status: 'failed', statusMessage: 'x' }));
    expect(local.bytesWritten / local.writeCount).toBeGreaterThan(1024);
    expect(JSON.stringify(local.data.get(STORAGE_KEYS.tasks))).not.toContain('segmentsDone');
    expect((await store.list()).find((task) => task.id === 'run')).toMatchObject({ status: 'failed', progress: { segmentsDone: 10 } });
  });

  it('reads tasks stored with their progress inline, before progress had its own key', async () => {
    const { local, store } = setup();
    const progress = { segmentsTotal: 10, segmentsDone: 4, bytes: 4, bytesPerSecond: 0, percent: 40, retries: 0, startedAt: 1 };
    await local.set({ [STORAGE_KEYS.tasks]: { version: 1, tasks: [makeTask('old', { status: 'failed', progress })] } });
    expect((await store.list())[0]?.progress).toEqual(progress);
    await store.update('old', (task) => ({ ...task, statusMessage: 'moved' }));
    expect(JSON.stringify(local.data.get(STORAGE_KEYS.tasks))).not.toContain('segmentsDone');
    expect((await store.list())[0]).toMatchObject({ statusMessage: 'moved', progress });
  });
});
