import { describe, expect, it, vi } from 'vitest';
import {
  DownloadCoordinator,
  SUBTITLE_LOST_MESSAGE,
  SUBTITLE_MISSING_MESSAGE,
  type CoordinatorDeps,
  type EngineChannel,
} from '@/core/download/download-coordinator';
import type { SegmentStorage } from '@/core/download/download-storage';
import {
  convertTrackFile,
  savedBaseName,
  subtitleDataUrl,
  subtitleFileName,
  subtitleSaveFailure,
} from '@/core/download/subtitle-saves';
import { parseTask, TaskStore } from '@/core/download/task-store';
import { containerMimeType } from '@/core/media/containers';
import type { RequestContext } from '@/core/models/detected-stream';
import type { DownloadTask, EngineWork, MediaTaskSpec, SaveRequest, TaskSubtitle } from '@/core/models/download-task';
import { DEFAULT_SETTINGS } from '@/shared/settings/settings';
import { blobOfUrl, FakeFiles, FakeNotifier } from '@tests/fakes/fake-files';
import { FakeStorageArea } from '@tests/fakes/fake-storage';
import { ANALYSED_MEDIA, makeTask } from '@tests/fakes/tasks';

/**
 * Subtitle files (0.7.0), service-worker side: named after the saved video,
 * saved after it, the task completed once they are; a progressive file's
 * `<track>` files fetched with the page's Referer and saved as data: URLs.
 */

const ENGLISH: TaskSubtitle = { id: 'subtitle-0', name: 'English', language: 'en' };
const FRENCH: TaskSubtitle = { id: 'subtitle-1', name: 'Français', language: 'fr' };
const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello <i>world</i> &amp; you\n';

describe('subtitle file names and contents', () => {
  it('names a subtitle after the saved video: language, forced, and the name only to tell two apart', () => {
    expect(savedBaseName('C:\\Users\\me\\Downloads\\Clips\\Movie (1).mp4')).toBe('Movie (1)');
    expect(savedBaseName('/home/me/Downloads/My.Movie.mkv')).toBe('My.Movie');
    const sdh: TaskSubtitle = { id: 'subtitle-2', name: 'English SDH', language: 'en' };
    const forced: TaskSubtitle = { id: 'subtitle-3', name: 'English (forced)', language: 'en', forced: true };
    const unknown: TaskSubtitle = { id: 'track-0', name: '' };
    expect(subtitleFileName('Movie (1)', FRENCH, [ENGLISH, FRENCH], 'srt')).toBe('Movie (1).fr.srt');
    expect(subtitleFileName('Movie', ENGLISH, [ENGLISH, sdh, forced], 'vtt')).toBe('Movie.en.English.vtt');
    expect(subtitleFileName('Movie', sdh, [ENGLISH, sdh, forced], 'vtt')).toBe('Movie.en.English SDH.vtt');
    expect(subtitleFileName('Movie', forced, [ENGLISH, sdh, forced], 'srt')).toBe('Movie.en.forced.srt');
    expect(subtitleFileName('Movie', unknown, [unknown], 'srt')).toBe('Movie.und.srt');
    // Characters a file name cannot hold, and dots that would read as extensions, go.
    expect(subtitleFileName('Movie', { id: 'x', name: 'x', language: 'pt/BR.x' }, [], 'srt')).not.toMatch(/[/\\]|\.x\./);
  });

  it('converts a <track> file to SubRip or clean WebVTT, refusing what is not WebVTT', () => {
    expect(convertTrackFile(VTT, 'srt')).toBe('1\r\n00:00:01,000 --> 00:00:02,500\r\nHello <i>world</i> & you\r\n');
    expect(convertTrackFile(`${VTT}\nSTYLE\n::cue { color: red }\n`, 'vtt')).toContain('00:00:01.000 --> 00:00:02.500');
    expect(() => convertTrackFile('<html>Not found</html>', 'srt')).toThrow(/not WebVTT/);
    expect(() => convertTrackFile('WEBVTT\n', 'srt')).toThrow(/no subtitles/);
  });

  it('writes UTF-8 data: URLs typed so Chrome keeps the extension', async () => {
    const url = subtitleDataUrl('1\r\nÉté 🌞\r\n', 'srt');
    expect(url.startsWith('data:application/x-subrip;base64,')).toBe(true);
    const blob = blobOfUrl(url);
    expect(blob?.type).toBe('application/x-subrip');
    expect(await blob?.text()).toBe('1\r\nÉté 🌞\r\n');
    expect(subtitleDataUrl('WEBVTT\n', 'vtt').startsWith('data:text/vtt;base64,')).toBe(true);
    expect(subtitleSaveFailure('FILE_NO_SPACE')).toMatch(/disk space/);
  });
});

class Engine implements EngineChannel {
  open = true;
  media: MediaTaskSpec[][] = [];
  exists = () => Promise.resolve(this.open);
  ensure = () => {
    this.open = true;
    return Promise.resolve();
  };
  close = () => Promise.resolve();
  sync = (work: EngineWork) => {
    this.media.push(work.media);
    return Promise.resolve([...work.downloads, ...work.media].map((task) => task.taskId));
  };
  cancel = () => Promise.resolve();
  reacquireContexts = () => Promise.resolve();
}

async function setup(tasks: { task: DownloadTask; context?: RequestContext }[], deps: Partial<CoordinatorDeps> = {}) {
  const store = new TaskStore(new FakeStorageArea('local'), new FakeStorageArea('session'));
  await store.add(tasks.map(({ task, context }) => ({ task, context: context ?? {} })));
  const engine = new Engine();
  const files = new FakeFiles();
  const notifier = new FakeNotifier();
  const deleted: string[] = [];
  const storage = {
    deleteTask: (id: string) => {
      deleted.push(id);
      return Promise.resolve();
    },
    summary: () => Promise.resolve(undefined),
    taskIds: () => Promise.resolve([]),
  } as unknown as SegmentStorage;
  const released: string[] = [];
  const acquireContext = vi.fn((url: string) =>
    Promise.resolve(() => {
      released.push(url);
      return Promise.resolve();
    }),
  );
  const coordinator = new DownloadCoordinator({
    store,
    storage,
    engine,
    files,
    notifier,
    acquireContext,
    getSettings: () => Promise.resolve(DEFAULT_SETTINGS),
    getStream: () => Promise.resolve(undefined),
    now: () => 5000,
    schedule: () => undefined,
    ...deps,
  });
  const taskOf = async (id: string) => (await store.list()).find((task) => task.id === id);
  return { store, engine, files, notifier, deleted, coordinator, taskOf, acquireContext, released };
}

const blobUrl = (text: string, type: string) => URL.createObjectURL(new Blob([text], { type }));

describe('DownloadCoordinator: subtitle files of merged videos (0.7.0)', () => {
  const processing = (id: string, subtitles: TaskSubtitle[] = [ENGLISH, FRENCH]) =>
    makeTask(id, {
      status: 'processing',
      processing: { stage: 'saving', step: 1, steps: 1, percent: 97, startedAt: 1 },
      selection: { variantId: 'video-0', variantLabel: '720p', audioTrackIds: [], audioTrackNames: [], subtitles },
      output: { baseName: `Movie_${id}`, format: 'mp4', subtitleFormat: 'srt' },
    });
  const request = (taskId: string, subtitles: SaveRequest['subtitles']): SaveRequest => ({
    taskId,
    url: blobUrl('merged file', containerMimeType('mp4')),
    container: 'mp4',
    size: 11,
    media: ANALYSED_MEDIA,
    ...(subtitles ? { subtitles } : {}),
  });

  it('asks the engine for subtitle files of HLS and DASH tasks, in the task’s format', async () => {
    const dash = makeTask('d', { status: 'downloaded', source: { ...makeTask('d').source, protocol: 'dash' }, selection: processing('d').selection });
    const { coordinator, engine } = await setup([{ task: dash }]);
    await coordinator.pump();
    expect(engine.media.at(-1)).toEqual([{ taskId: 'd', job: 'process', format: 'auto', title: 'Movie', subtitles: { protocol: 'dash', format: 'srt' } }]);
  });

  it('saves the subtitle files after the video, named after its final name, and completes the task once they are saved', async () => {
    const { coordinator, files, notifier, deleted, taskOf } = await setup([{ task: processing('a') }]);
    // A file of that name is already there: Chrome names the video "Movie_a (1).mp4", and the subtitles follow it.
    await files.save({ url: blobUrl('old', 'video/mp4'), fileName: 'Movie_a.mp4' });
    files.manual = true;
    const english = blobUrl('1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n', 'application/x-subrip');
    await coordinator.startSave(request('a', [{ trackId: ENGLISH.id, url: english, size: 40 }, { trackId: FRENCH.id, error: 'The subtitle track is not WebVTT.' }]));
    expect((await taskOf('a'))?.output.subtitles).toEqual([
      { trackId: ENGLISH.id, url: english },
      { trackId: FRENCH.id, error: 'The subtitle track is not WebVTT.' },
    ]);

    files.finish(2);
    await coordinator.handleFileChange(2);
    expect(files.entries.get(3)).toMatchObject({ url: english, path: '/Downloads/Movie_a (1).en.srt', state: 'in_progress' });
    // The subtitle file is still being saved: the task waits (the engine keeps its blob: URLs meanwhile).
    expect(await taskOf('a')).toMatchObject({ status: 'processing', output: { subtitles: [{ trackId: ENGLISH.id, downloadId: 3 }, {}] } });
    expect(notifier.shown).toEqual([]);

    files.finish(3);
    await coordinator.handleFileChange(3);
    const task = await taskOf('a');
    expect(task).toMatchObject({ status: 'completed', output: { saved: { path: '/Downloads/Movie_a (1).mp4' } } });
    expect(task?.output.subtitles).toEqual([
      { trackId: ENGLISH.id, downloadId: 3, saved: { path: '/Downloads/Movie_a (1).en.srt', bytes: 38, savedAt: 5000 } },
      { trackId: FRENCH.id, error: 'The subtitle track is not WebVTT.' },
    ]);
    expect(await files.entries.get(3)?.data?.text()).toContain('Hi');
    expect(deleted).toEqual(['a']);
    expect(notifier.shown).toEqual([{ kind: 'completed', taskId: 'a' }]);
    // Events arriving again change nothing.
    await coordinator.handleFileChange(3);
    await coordinator.handleFileChange(2);
    expect(files.entries.size).toBe(3);
    expect(notifier.shown).toHaveLength(1);
    // The stored task reads back the same.
    expect(parseTask(JSON.parse(JSON.stringify(task)))?.output.subtitles).toEqual(task?.output.subtitles);
  });

  it('completes the task with the video when a subtitle file fails to save, saying why', async () => {
    const { coordinator, files, taskOf } = await setup([{ task: processing('f', [ENGLISH]) }]);
    files.manual = true;
    await coordinator.startSave(request('f', [{ trackId: ENGLISH.id, url: blobUrl('x', 'application/x-subrip'), size: 1 }]));
    files.finish(1);
    await coordinator.handleFileChange(1);
    files.finish(2, 'FILE_NO_SPACE');
    await coordinator.handleFileChange(2);
    expect(await taskOf('f')).toMatchObject({
      status: 'completed',
      output: { subtitles: [{ trackId: ENGLISH.id, downloadId: 2, error: subtitleSaveFailure('FILE_NO_SPACE') }] },
    });
  });

  it('records a chosen track the engine sent no file for', async () => {
    const { coordinator, taskOf } = await setup([{ task: processing('m', [ENGLISH]) }]);
    await coordinator.startSave(request('m', undefined));
    expect(await taskOf('m')).toMatchObject({ status: 'completed', output: { subtitles: [{ trackId: ENGLISH.id, error: SUBTITLE_MISSING_MESSAGE }] } });
  });

  it('cancelling stops subtitle saves too; Retry starts without them', async () => {
    const { coordinator, files, taskOf } = await setup([{ task: processing('c', [ENGLISH]) }]);
    files.manual = true;
    await coordinator.startSave(request('c', [{ trackId: ENGLISH.id, url: blobUrl('x', 'application/x-subrip'), size: 1 }]));
    files.finish(1);
    await coordinator.handleFileChange(1);
    expect(files.entries.get(2)?.state).toBe('in_progress');
    await coordinator.cancel(['c']);
    expect(files.cancelled).toContain(2);
    expect((await taskOf('c'))?.status).toBe('cancelled');
    await coordinator.retry(['c']);
    expect((await taskOf('c'))?.output.subtitles).toBeUndefined();
  });

  it('ends the task when the video is removed from Chrome’s downloads while its subtitles are saved', async () => {
    const { coordinator, files, taskOf } = await setup([{ task: processing('e', [ENGLISH]) }]);
    files.manual = true;
    await coordinator.startSave(request('e', [{ trackId: ENGLISH.id, url: blobUrl('x', 'application/x-subrip'), size: 1 }]));
    files.finish(1);
    await coordinator.handleFileChange(1);
    files.erase(1);
    files.finish(2);
    await coordinator.handleFileChange(2);
    expect((await taskOf('e'))?.status).toBe('failed');
  });

  it('after a restart without the engine, a saved video completes and its unsaved subtitle files are reported lost', async () => {
    const files = new FakeFiles();
    const video = await files.save({ url: blobUrl('merged', 'video/mp4'), fileName: 'Movie_r.mp4' });
    files.manual = true;
    const sub = await files.save({ url: blobUrl('x', 'application/x-subrip'), fileName: 'Movie_r.en.srt' });
    const task = processing('r', [ENGLISH, FRENCH]);
    task.output = { ...task.output, downloadId: video, subtitles: [{ trackId: ENGLISH.id, downloadId: sub }, { trackId: FRENCH.id, url: 'blob:gone/1' }] };
    const { coordinator, engine, taskOf } = await setup([{ task }], { files });
    engine.open = false;
    await coordinator.onStartup();
    const settled = await taskOf('r');
    // Not merged again: the video is in the Downloads folder.
    expect(settled?.status).toBe('completed');
    expect(settled?.output.subtitles).toEqual([
      { trackId: ENGLISH.id, downloadId: sub, error: SUBTITLE_LOST_MESSAGE },
      { trackId: FRENCH.id, error: SUBTITLE_LOST_MESSAGE },
    ]);
    expect(files.cancelled).toContain(sub);
    expect(engine.media.flat()).toEqual([]);
  });
});

describe('DownloadCoordinator: <track> files of progressive videos (0.7.0)', () => {
  const PAGE = { referer: 'https://site.example/watch/1' };
  const TRACK = 'https://site.example/subs/en.vtt';
  const fileTask = (id: string, subtitles: TaskSubtitle[]) =>
    makeTask(id, {
      status: 'queued',
      source: { protocol: 'progressive', manifestUrl: `https://media.example.net/${id}.mp4`, title: 'Clip', tabId: 3, streamId: `f-${id}` },
      selection: { variantId: 'file', variantLabel: 'Single quality', audioTrackIds: [], audioTrackNames: [], subtitles },
      output: { baseName: `Clip_${id}`, format: 'auto', subtitleFormat: 'srt' },
      progressive: { container: 'mp4', fetch: 'browser' },
    });

  it("fetches each <track> file with the page's Referer once the video is saved, and saves it next to it", async () => {
    const fetched: { url: string; init: RequestInit }[] = [];
    const fetch = (url: string, init: RequestInit) => {
      fetched.push({ url, init });
      return Promise.resolve(url === TRACK ? new Response(VTT, { headers: { 'content-type': 'text/vtt' } }) : new Response('nope', { status: 404 }));
    };
    const track: TaskSubtitle = { id: 'track-0', name: 'English', language: 'en', url: TRACK };
    const broken: TaskSubtitle = { id: 'track-1', name: 'Deutsch', language: 'de', url: 'https://site.example/subs/de.vtt' };
    const { coordinator, files, taskOf, acquireContext, released } = await setup([{ task: fileTask('p', [track, broken]), context: PAGE }], { fetch });
    await coordinator.pump();
    await coordinator.handleFileChange(1);
    await vi.waitFor(async () => expect((await taskOf('p'))?.output.subtitles?.every((file) => file.saved || file.error)).toBe(true));

    const task = await taskOf('p');
    expect(task?.status).toBe('completed');
    expect(task?.output.subtitles).toEqual([
      { trackId: 'track-0', downloadId: 2, saved: { path: '/Downloads/Clip_p.en.srt', bytes: expect.any(Number) as number, savedAt: 5000 } },
      { trackId: 'track-1', error: 'The subtitle file could not be saved: HTTP 404.' },
    ]);
    expect(await files.entries.get(2)?.data?.text()).toBe('1\r\n00:00:01,000 --> 00:00:02,500\r\nHello <i>world</i> & you\r\n');
    expect(fetched[0]?.init).toMatchObject({ credentials: 'include' });
    expect(acquireContext).toHaveBeenCalledWith(TRACK, PAGE);
    expect(released).toContain(TRACK);
  });

  it('saves <track> files a restart interrupted, on the next start', async () => {
    const files = new FakeFiles();
    const video = await files.save({ url: 'https://media.example.net/s.mp4', fileName: 'Clip_s.mp4' });
    const task = fileTask('s', [{ id: 'track-0', name: 'English', language: 'en', url: TRACK }]);
    Object.assign(task, { status: 'completed' });
    task.output = { ...task.output, downloadId: video, saved: { path: '/Downloads/Clip_s.mp4', bytes: 1000, savedAt: 1 }, subtitles: [{ trackId: 'track-0' }] };
    const { coordinator, taskOf } = await setup([{ task, context: PAGE }], { files, fetch: () => Promise.resolve(new Response(VTT)) });
    await coordinator.onStartup();
    await vi.waitFor(async () => expect((await taskOf('s'))?.output.subtitles?.[0]?.saved).toBeDefined());
    expect((await taskOf('s'))?.output.subtitles).toEqual([
      { trackId: 'track-0', downloadId: 2, saved: { path: '/Downloads/Clip_s.en.srt', bytes: expect.any(Number) as number, savedAt: 5000 } },
    ]);
  });
});
