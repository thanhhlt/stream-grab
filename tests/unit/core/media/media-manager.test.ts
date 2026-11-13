import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { IndexedDbSegmentStorage } from '@/core/download/download-storage';
import { FfmpegError, type FfmpegJob, type FfmpegResult, type FfmpegRunner, type FfmpegRunOptions } from '@/core/media/ffmpeg-job';
import { NO_DATA_MESSAGE, OLD_LAYOUT_MESSAGE } from '@/core/media/media-analysis';
import { MediaManager, type MediaManagerDeps } from '@/core/media/media-manager';
import { parseProbeOutput, probeJob } from '@/core/media/probe';
import type { MediaReport, MediaTaskSpec, SaveRequest } from '@/core/models/download-task';
import type { OutputFormat } from '@/shared/settings/settings';
import { probeResult, ScriptedRunner } from '@tests/fakes/fake-ffmpeg';
import { NodeFfmpegRunner } from '@tests/fakes/ffmpeg-node';
import { MemoryOutputFiles } from '@tests/fakes/output-files';
import { storeDownloadedTask, storeSegments, type StoredSegmentSpec } from '@tests/fakes/stored-media';
import { syntheticMedia, type Rendition, type SyntheticMedia } from '@tests/fixtures/media/synthetic-media';

/**
 * Media jobs of the engine: analyse, merge, hand the file over for saving.
 * The first group runs the real FFmpeg core on synthetic H.264/AAC media
 * stored in IndexedDB the way downloads leave it; the second scripts FFmpeg's
 * answers to reach every outcome.
 */

let media: SyntheticMedia;
const ffmpeg = new NodeFfmpegRunner();

beforeAll(async () => {
  media = await syntheticMedia();
}, 60_000);

function setup(runner: FfmpegRunner = ffmpeg, overrides: Partial<MediaManagerDeps> = {}) {
  const storage = new IndexedDbSegmentStorage(new IDBFactory());
  const reports: MediaReport[] = [];
  const saves: SaveRequest[] = [];
  const urls = new Map<string, Blob>();
  const revoked: string[] = [];
  let clock = 1000;
  let nextUrl = 0;
  const manager = new MediaManager({
    storage,
    ffmpeg: runner,
    report: (report) => reports.push(report),
    save: (request) => {
      saves.push(request);
      return Promise.resolve(true);
    },
    createUrl: (blob) => {
      const url = `blob:test/${++nextUrl}`;
      urls.set(url, blob);
      return url;
    },
    revokeUrl: (url) => {
      revoked.push(url);
      urls.delete(url);
    },
    now: () => (clock += 10),
    reportIntervalMs: 0,
    ...overrides,
  });
  const process = async (taskId: string, format: OutputFormat = 'auto') => {
    const spec: MediaTaskSpec = { taskId, job: 'process', format, title: `Video ${taskId}` };
    manager.sync([spec]);
    await manager.idle();
    return reports.filter((report) => report.taskId === taskId);
  };
  /** Reads the handed-over file back with FFmpeg. */
  const probeSaved = async (request: SaveRequest | undefined) => {
    const blob = request ? urls.get(request.url) : undefined;
    if (!blob) return null;
    return parseProbeOutput((await ffmpeg.run(probeJob(`check.${request?.container ?? 'mp4'}`, blob))).stdout);
  };
  return { storage, manager, reports, saves, urls, revoked, process, probeSaved };
}

const video = (rendition: Rendition) => ({ trackId: 'main', trackType: 'main' as const, rendition });
const english = (rendition: Rendition) => ({ trackId: 'audio-0', trackType: 'audio' as const, rendition, name: 'English' });

describe('MediaManager · process (real FFmpeg)', () => {
  it('scenario 1/HLS MPEG-TS: analyses, merges separate video and audio, and hands the file over', async () => {
    const { storage, manager, saves, urls, revoked, process, probeSaved, reports } = setup();
    await storeDownloadedTask(storage, 't', [video(media.ts.video['v180'] as Rendition), english(media.ts.audio)]);
    await process('t');
    expect(reports.some((report) => report.outcome)).toBe(false); // success is the save, not a report
    expect(saves).toHaveLength(1);
    const request = saves[0];
    expect(request).toMatchObject({ taskId: 't', container: 'mp4' });
    expect(request?.media).toMatchObject({
      container: 'mp4',
      tracks: [
        { trackId: 'main', trackType: 'main', format: 'mpegts', segments: 4, streams: [{ kind: 'video', codec: 'h264', width: 320, height: 180, frameRate: 10 }] },
        { trackId: 'audio-0', trackType: 'audio', name: 'English', format: 'mpegts', segments: 4, streams: [{ kind: 'audio', codec: 'aac', channels: 2, sampleRate: 48000 }] },
      ],
    });
    const merged = await probeSaved(request);
    expect(merged?.format).toContain('mp4');
    expect(merged?.streams.map((stream) => stream.codec)).toEqual(['h264', 'aac']);
    expect(merged?.durationSec).toBeCloseTo(8, 0);
    expect(request?.size).toBeGreaterThan(0);
    // Typed, so Chrome keeps the .mp4 extension (an untyped blob is saved as .txt).
    expect(request ? urls.get(request.url)?.type : undefined).toBe('video/mp4');
    // Every stage the Queue tab shows, in order.
    const stages = reports.map((report) => report.progress.stage).filter((stage, i, all) => stage !== all[i - 1]);
    expect(stages).toEqual(['preparing', 'loading', 'analysing', 'merging', 'verifying', 'saving']);
    expect(reports.at(-1)?.progress.percent).toBe(97);

    // Held while Chrome saves it; released (never deleted by the engine) when the service worker is done.
    expect(manager.running).toEqual(['t']);
    expect(manager.sync([{ taskId: 't', job: 'process', format: 'auto', title: '' }])).toEqual(['t']);
    expect(revoked).toEqual([]);
    manager.sync([]);
    expect(revoked).toEqual([request?.url]);
    expect(manager.running).toEqual([]);
    expect(await storage.taskIds()).toEqual(['t']);
  });

  it('scenario 2/3: fragmented MP4 tracks with init segments (HLS EXT-X-MAP, DASH)', async () => {
    const { storage, saves, process, probeSaved } = setup();
    await storeDownloadedTask(storage, 'd', [video(media.fmp4.video['v90'] as Rendition), english(media.fmp4.audio)]);
    await process('d');
    expect(saves[0]?.media?.tracks.map((track) => [track.format.includes('mp4'), track.segments])).toEqual([
      [true, 5],
      [true, 5],
    ]);
    const merged = await probeSaved(saves[0]);
    expect(merged?.streams.map((stream) => `${stream.kind}:${stream.codec}:${stream.width ?? ''}`)).toEqual(['video:h264:160', 'audio:aac:']);
    expect(merged?.durationSec).toBeCloseTo(8, 0);
  });

  it('merges muxed audio and video from one track into a forced MKV', async () => {
    const { storage, saves, urls, process, probeSaved } = setup();
    await storeDownloadedTask(storage, 'm', [video(media.ts.muxed)]);
    await process('m', 'mkv');
    expect(saves[0]?.container).toBe('mkv');
    expect(urls.get(saves[0]?.url ?? '')?.type).toBe('video/x-matroska');
    const merged = await probeSaved(saves[0]);
    expect(merged?.format).toContain('matroska');
    expect(merged?.streams.map((stream) => stream.kind)).toEqual(['video', 'audio']);
  });

  it('fails on data that is not media and discards it, so Retry downloads it again', async () => {
    const { storage, saves, process } = setup();
    const html = new TextEncoder().encode('<html><body>Access denied</body></html>'.repeat(50));
    await storeDownloadedTask(storage, 'junk', [video({ segments: [html, html], durations: [4, 4] })]);
    expect((await process('junk')).at(-1)?.outcome).toEqual({
      status: 'failed',
      discardedData: true,
      message:
        'FFmpeg cannot read the video track as media (Invalid data found when processing input). The server may have sent something other than video segments; press Retry to download it again.',
    });
    expect(await storage.taskIds()).toEqual([]);
    expect(saves).toEqual([]);
  });

  it('fails without discarding when segments are missing, or the plan predates Phase 8', async () => {
    const { storage, process } = setup();
    await storeDownloadedTask(storage, 'gap', [video(media.ts.video['v90'] as Rendition)]);
    await storage.deleteSegment('gap', 'main', 2);
    expect((await process('gap')).at(-1)?.outcome).toEqual({
      status: 'failed',
      message: '1 of 4 segments are missing from storage. Press Retry to download them again.',
    });
    expect(await storage.taskIds()).toEqual(['gap']);

    await storeDownloadedTask(storage, 'old', [video(media.ts.video['v90'] as Rendition)]);
    const plan = await storage.getPlan('old');
    const { layout: _layout, ...phase7 } = plan ?? { taskId: 'old', signature: 'x', segmentsTotal: 4, updatedAt: 1 };
    await storage.savePlan(phase7);
    expect((await process('old')).at(-1)?.outcome).toEqual({ status: 'failed', message: OLD_LAYOUT_MESSAGE });
    expect((await process('nothing')).at(-1)?.outcome).toEqual({ status: 'failed', message: NO_DATA_MESSAGE });
  });
});

const VIDEO = { codec_type: 'video', codec_name: 'h264', width: 320, height: 180 };
const AUDIO = { codec_type: 'audio', codec_name: 'aac', channels: 2 };
const merged = (job: FfmpegJob): FfmpegResult => ({ ...probeResult([]), exitCode: 0, stdout: '', outputs: [{ name: job.outputs[0] ?? '', data: new Blob(['merged']) }] });

/** FFmpeg answers: tracks hold video, the merged file `output` streams; the merge may be replaced. */
function scripted(options: { output?: object[]; merge?: (job: FfmpegJob, run: FfmpegRunOptions) => Promise<FfmpegResult> } = {}): ScriptedRunner {
  return new ScriptedRunner((job, run) => {
    if (job.tool === 'ffmpeg') return options.merge ? options.merge(job, run) : Promise.resolve(merged(job));
    if (job.inputs[0]?.name.startsWith('output.')) return Promise.resolve(probeResult(options.output ?? [VIDEO, AUDIO]));
    run.signal?.throwIfAborted();
    return Promise.resolve(probeResult([VIDEO, AUDIO]));
  });
}

/** A merge that runs until it is aborted. */
const endless = (_job: FfmpegJob, run: FfmpegRunOptions): Promise<FfmpegResult> =>
  new Promise((_, reject) => {
    run.signal?.addEventListener('abort', () => {
      reject(new DOMException('FFmpeg job aborted', 'AbortError'));
    });
  });

describe('MediaManager · outcomes', () => {
  it('refuses a forced MP4 for codecs MP4 cannot hold, keeping the data', async () => {
    const runner = new ScriptedRunner(() => Promise.resolve(probeResult([{ codec_type: 'video', codec_name: 'vp8' }, { codec_type: 'audio', codec_name: 'vorbis' }])));
    const { storage, saves, process } = setup(runner);
    await storeDownloadedTask(storage, 'w', [video(media.ts.video['v90'] as Rendition)]);
    expect((await process('w', 'mp4')).at(-1)?.outcome).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('VP8 and Vorbis cannot be stored in MP4') as string,
      reason: 'mp4-unsupported',
    });
    expect(await storage.taskIds()).toEqual(['w']);
    expect(saves).toEqual([]);
  });

  it('words FFmpeg failures and keeps the data', async () => {
    const runner = new ScriptedRunner(() => Promise.reject(new FfmpegError('FFmpeg could not be loaded: CompileError', 'load')));
    const { storage, process } = setup(runner);
    await storeDownloadedTask(storage, 'l', [video(media.ts.video['v90'] as Rendition)]);
    expect((await process('l')).at(-1)?.outcome).toEqual({ status: 'failed', message: 'FFmpeg could not be loaded: CompileError Press Retry to try again.' });
    expect(await storage.taskIds()).toEqual(['l']);
  });

  it('sends a failure again to a sync built before it arrived, instead of running the job twice (0.9.0)', async () => {
    let runs = 0;
    const runner = new ScriptedRunner(() => {
      runs += 1;
      return Promise.reject(new FfmpegError('FFmpeg could not be loaded: CompileError', 'load'));
    });
    const { storage, manager, reports, process } = setup(runner);
    await storeDownloadedTask(storage, 'l', [video(media.ts.video['v90'] as Rendition)]);
    await process('l');
    const ran = runs;
    // Stale: the service worker had not seen the failure yet. Its next sync would have cancelled a
    // second job and deleted the segments Retry needs.
    expect((await process('l')).filter((report) => report.outcome).map((report) => report.outcome?.status)).toEqual(['failed', 'failed']);
    expect(runs).toBe(ran);
    await manager.syncSettled([]);
    expect(await storage.taskIds()).toEqual(['l']);
    // Listed again after a sync without it: a real new job (Retry).
    await process('l');
    expect(runs).toBeGreaterThan(ran);
    expect(reports.at(-1)?.outcome?.status).toBe('failed');
  });

  it('reports a failed merge with FFmpeg’s reason, and a merged file that lacks streams', async () => {
    const failing = scripted({
      merge: () => Promise.resolve({ ...probeResult([]), exitCode: 1, stdout: '', stderrTail: ['[mp4 @ 0x1] Could not write header: Invalid argument', 'Aborted()'] }),
    });
    const first = setup(failing);
    await storeDownloadedTask(first.storage, 'f', [video(media.ts.muxed)]);
    expect((await first.process('f')).at(-1)?.outcome).toEqual({
      status: 'failed',
      message: 'FFmpeg could not merge the tracks ([mp4 @ 0x1] Could not write header: Invalid argument). Press Retry to try again; the downloaded segments are kept.',
    });
    expect(await first.storage.taskIds()).toEqual(['f']);

    const short = setup(scripted({ output: [VIDEO] }));
    await storeDownloadedTask(short.storage, 's', [video(media.ts.muxed)]);
    expect((await short.process('s')).at(-1)?.outcome).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('does not contain the expected 1 video and 1 audio streams') as string,
    });
    expect(short.saves).toEqual([]);
    expect(short.revoked).toEqual([]); // nothing was handed out
  });

  it('does not start a merge the disk cannot hold, keeping the segments', async () => {
    const runner = scripted();
    const { storage, saves, process } = setup(runner, { estimateStorage: () => Promise.resolve({ usage: 0, quota: 300 * 1024 * 1024 }) });
    const segments = [new Uint8Array(30 * 1024 * 1024).fill(0x47), new Uint8Array(30 * 1024 * 1024).fill(0x47)];
    await storeDownloadedTask(storage, 'big', [video({ segments, durations: [4, 4] })]);
    expect((await process('big')).at(-1)?.outcome).toEqual({
      status: 'failed',
      message:
        'Not enough disk space to merge this video: about 376 MB is needed for the merged file and its saved copy, 300 MB is free. Free up disk space, then press Retry; the downloaded segments are kept.',
    });
    expect(runner.jobs.some((job) => job.tool === 'ffmpeg')).toBe(false);
    expect(saves).toEqual([]);
    expect(await storage.taskIds()).toEqual(['big']);
  });

  it('cancels a running merge: FFmpeg is stopped and the data deleted', async () => {
    const runner = scripted({ merge: endless });
    const { storage, manager, reports, saves } = setup(runner);
    await storeDownloadedTask(storage, 'c', [video(media.ts.muxed)]);
    manager.sync([{ taskId: 'c', job: 'process', format: 'auto', title: '' }]);
    await waitFor(() => reports.some((report) => report.progress.stage === 'merging'));
    await manager.cancel(['c']);
    expect(reports.at(-1)?.outcome).toEqual({ status: 'cancelled' });
    expect(await storage.taskIds()).toEqual([]);
    expect(saves).toEqual([]);
    expect(manager.running).toEqual([]);
  });

  it('cancels while Chrome saves the file: the URL is released and the data deleted', async () => {
    const { storage, manager, reports, revoked, saves, process } = setup(scripted());
    await storeDownloadedTask(storage, 'h', [video(media.ts.muxed)]);
    await process('h');
    expect(manager.running).toEqual(['h']);
    await manager.cancel(['h']);
    expect(revoked).toEqual([saves[0]?.url]);
    expect(reports.at(-1)?.outcome).toEqual({ status: 'cancelled' });
    expect(await storage.taskIds()).toEqual([]);
  });

  it('lets go of the file when the service worker no longer wants it, keeping the data', async () => {
    const { storage, manager, reports, revoked, saves, process } = setup(scripted(), { save: () => Promise.resolve(false) });
    await storeDownloadedTask(storage, 'n', [video(media.ts.muxed)]);
    await process('n');
    expect(saves).toEqual([]); // the override did not record it
    expect(revoked).toHaveLength(1);
    expect(reports.at(-1)?.outcome).toEqual({ status: 'cancelled' });
    expect(manager.running).toEqual([]);
    expect(await storage.taskIds()).toEqual(['n']);
  });

  it('converges on the job list: an unlisted job is stopped before syncSettled answers', async () => {
    const runner = scripted({ merge: endless });
    const { storage, manager, reports } = setup(runner);
    await storeDownloadedTask(storage, 'a', [video(media.ts.muxed)]);
    expect(manager.sync([{ taskId: 'a', job: 'process', format: 'auto', title: '' }])).toEqual(['a']);
    await waitFor(() => reports.some((report) => report.progress.stage === 'merging'));
    await expect(manager.syncSettled([])).resolves.toEqual([]);
    expect(reports.at(-1)).toMatchObject({ taskId: 'a', outcome: { status: 'cancelled' } });
  });
});

describe('MediaManager · merged files on disk (0.4.0)', () => {
  const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
  /** A manager whose FFmpeg writes merged files to `files`, as the media worker writes them to OPFS. */
  const onDisk = (overrides: Partial<MediaManagerDeps> = {}) => {
    const files = new MemoryOutputFiles();
    return { files, ...setup(new NodeFfmpegRunner({ files }), { files, ...overrides }) };
  };
  const fileOf = (taskId: string, extension = 'mp4') => new RegExp(`^${taskId}\\.[a-z0-9]+\\.${extension}$`);

  it('merges into a file of its own, hands it over typed, and deletes it once Chrome has saved its copy', async () => {
    const { files, storage, manager, saves, urls, process, probeSaved } = onDisk();
    await storeDownloadedTask(storage, 't', [video(media.ts.video['v180'] as Rendition), english(media.ts.audio)]);
    await process('t');
    const [name = ''] = files.opened;
    expect(name).toMatch(fileOf('t'));
    expect(urls.get(saves[0]?.url ?? '')?.type).toBe('video/mp4');
    expect(saves[0]?.size).toBe(files.files.get(name)?.size);
    expect((await probeSaved(saves[0]))?.streams.map((stream) => stream.codec)).toEqual(['h264', 'aac']);
    // Kept while Chrome saves it: a download that has not started fails once its file is gone.
    expect(await files.names()).toEqual([name]);
    manager.sync([]);
    await waitFor(() => files.files.size === 0);
    expect(files.removed).toEqual([name]);
    expect(await storage.taskIds()).toEqual(['t']); // the segments are the service worker's to delete
  });

  it('types a Matroska file for Chrome, and merges every attempt into a new file', async () => {
    const { files, storage, manager, saves, urls, process, probeSaved } = onDisk();
    await storeDownloadedTask(storage, 'm', [video(media.ts.muxed)]);
    await process('m', 'mkv');
    expect(files.opened[0]).toMatch(fileOf('m', 'mkv'));
    expect(urls.get(saves[0]?.url ?? '')?.type).toBe('video/x-matroska'); // the file says video/matroska
    expect((await probeSaved(saves[0]))?.format).toContain('matroska');
    manager.sync([]);
    await process('m', 'mkv');
    expect(files.opened).toHaveLength(2);
    expect(files.opened[1]).not.toBe(files.opened[0]);
  });

  it('reports a full disk in words the user can act on, deleting the file and keeping the segments', async () => {
    const { files, storage, saves, process } = onDisk();
    files.quota = 16 * 1024;
    await storeDownloadedTask(storage, 'full', [video(media.ts.muxed)]);
    expect((await process('full')).at(-1)?.outcome).toEqual({
      status: 'failed',
      message: 'There is not enough disk space to write the merged file. Free up disk space, then press Retry; the downloaded segments are kept.',
    });
    expect(await files.names()).toEqual([]);
    expect(saves).toEqual([]);
    expect(await storage.taskIds()).toEqual(['full']);
  });

  it('merges into Blob parts when the file cannot be opened, and logs why', async () => {
    const log = logger();
    const { files, storage, saves, urls, process, probeSaved } = onDisk({ logger: log });
    files.failOpen = new Error('Synchronous file access is not available here');
    await storeDownloadedTask(storage, 'mem', [video(media.ts.muxed)]);
    await process('mem');
    expect(urls.get(saves[0]?.url ?? '')?.type).toBe('video/mp4');
    expect((await probeSaved(saves[0]))?.streams.map((stream) => stream.kind)).toEqual(['video', 'audio']);
    expect(log.warn).toHaveBeenCalledWith('The merged file could not be written to disk, so it was kept in memory', {
      error: 'Synchronous file access is not available here',
    });
  });

  it('deletes the file of a merge that failed its check, was cancelled, or is no longer wanted', async () => {
    const failed = new MemoryOutputFiles();
    const short = setup(scripted({ output: [VIDEO] }), { files: failed });
    await storeDownloadedTask(short.storage, 's', [video(media.ts.muxed)]);
    expect((await short.process('s')).at(-1)?.outcome).toMatchObject({ status: 'failed' });
    expect(failed.removeCalls).toEqual([expect.stringMatching(fileOf('s'))]);

    // Cancelled while FFmpeg writes it: the file is released when the worker is terminated, then deleted.
    const writing = new MemoryOutputFiles();
    const running = setup(
      scripted({
        merge: (job, run) => {
          const handle = writing.leave(Object.values(job.outputFiles ?? {})[0] ?? '', true);
          run.signal?.addEventListener('abort', () => {
            handle.closed = true;
          });
          return endless(job, run);
        },
      }),
      { files: writing },
    );
    await storeDownloadedTask(running.storage, 'c', [video(media.ts.muxed)]);
    running.manager.sync([{ taskId: 'c', job: 'process', format: 'auto', title: '' }]);
    await waitFor(() => running.reports.some((report) => report.progress.stage === 'merging'));
    await running.manager.cancel(['c']);
    expect(writing.removed).toEqual([expect.stringMatching(fileOf('c'))]);

    // Cancelled while Chrome saves it.
    const saving = onDisk();
    await storeDownloadedTask(saving.storage, 'h', [video(media.ts.muxed)]);
    await saving.process('h');
    expect(saving.files.files.size).toBe(1);
    await saving.manager.cancel(['h']);
    await waitFor(() => saving.files.files.size === 0);

    // Merged after the task was cancelled or removed.
    const refused = onDisk({ save: () => Promise.resolve(false) });
    await storeDownloadedTask(refused.storage, 'n', [video(media.ts.muxed)]);
    await refused.process('n');
    expect(refused.files.files.size).toBe(0);
    expect(refused.files.removed).toHaveLength(1);
  });

  it('leaves a file it cannot delete yet to the service worker’s cleanup', async () => {
    const log = logger();
    const files = { remove: vi.fn(() => Promise.resolve('locked' as const)) };
    const { storage, process } = setup(scripted({ output: [VIDEO] }), { files, logger: log, fileLockWaitMs: 50 });
    await storeDownloadedTask(storage, 'x', [video(media.ts.muxed)]);
    await process('x');
    expect(files.remove).toHaveBeenCalledWith(expect.stringMatching(fileOf('x')), { waitLockedMs: 50 });
    expect(log.warn).toHaveBeenCalledWith('A merged file is still open and was left for cleanup', { file: expect.stringMatching(fileOf('x')) as string });
  });
});

describe('MediaManager · timestamps that go back (real FFmpeg)', () => {
  /** A rendition's segments `times` times over: every repetition restarts the timestamps at the start. */
  function repeated(rendition: Rendition, times: number, options: { tagged?: 'all' | 'first'; initEachTime?: boolean } = {}): StoredSegmentSpec[] {
    const segments: StoredSegmentSpec[] = [];
    for (let k = 0; k < times; k++) {
      const discontinuity = options.tagged === 'all' ? k : options.tagged === 'first' ? Math.min(k, 1) : 0;
      if (rendition.init && (k === 0 || options.initEachTime)) segments.push({ body: rendition.init, duration: 0, init: true, discontinuity });
      rendition.segments.forEach((body, i) => segments.push({ body, duration: rendition.durations[i] ?? 2, discontinuity }));
    }
    return segments;
  }

  async function merge(container: 'fmp4' | 'mpeg-ts', main: StoredSegmentSpec[], audio: StoredSegmentSpec[]) {
    const { storage, saves, process, probeSaved, reports } = setup();
    await storeSegments(storage, 't', [
      { trackId: 'main', trackType: 'main', container, segments: main },
      { trackId: 'audio-0', trackType: 'audio', container, segments: audio, name: 'English' },
    ]);
    await process('t');
    return { failure: reports.find((report) => report.outcome)?.outcome, merged: await probeSaved(saves[0]) };
  }

  // Regression: a 2.5 GB, 7407 s video came out "30 of 7407 seconds" long: FFmpeg clamps decode times that
  // go back, so everything after the jump was squeezed onto its end.
  it('MPEG-TS: a jump back inside a run joined by the concat demuxer (only the first boundary tagged)', async () => {
    const v = media.ts.video['v180'] as Rendition;
    const { failure, merged } = await merge('mpeg-ts', repeated(v, 5, { tagged: 'first' }), repeated(media.ts.audio, 5, { tagged: 'first' }));
    expect(failure).toBeUndefined();
    expect(merged?.streams.map((stream) => stream.kind)).toEqual(['video', 'audio']);
    expect(merged?.durationSec).toBeCloseTo(40, 0);
  });

  it('fragmented MP4: tfdt going back without any tag (FFmpeg corrects none in MP4 input)', async () => {
    const v = media.fmp4.video['v180'] as Rendition;
    const { failure, merged } = await merge('fmp4', repeated(v, 5), repeated(media.fmp4.audio, 5));
    expect(failure).toBeUndefined();
    expect(merged?.durationSec).toBeCloseTo(40, 0);
  });

  it('fragmented MP4: a new initialization segment at each discontinuity is analysed from the first run, not discarded', async () => {
    const v = media.fmp4.video['v180'] as Rendition;
    const { failure, merged } = await merge('fmp4', repeated(v, 5, { tagged: 'all', initEachTime: true }), repeated(media.fmp4.audio, 5, { tagged: 'all', initEachTime: true }));
    expect(failure).toBeUndefined();
    expect(merged?.durationSec).toBeCloseTo(40, 0);
  });

  it('fragmented MP4: every segment starting over at 0 becomes a run of its own', async () => {
    const v = media.fmp4.video['v180'] as Rendition;
    const first = (rendition: Rendition): Rendition => ({
      ...rendition,
      segments: [rendition.segments[0] as Uint8Array<ArrayBuffer>],
      durations: [rendition.durations[0] ?? 2],
    });
    const { failure, merged } = await merge('fmp4', repeated(first(v), 20), repeated(first(media.fmp4.audio), 20));
    expect(failure).toBeUndefined();
    expect(merged?.durationSec).toBeCloseTo(40, 0);
  });

  // Regression (the same 2.5 GB report): the site disguised its segments as pictures. FFmpeg took the part after
  // the ad's discontinuity for a PNG and read no video from it, so only the 30-second ad was merged.
  it('MPEG-TS segments disguised as pictures: the picture header is skipped (PNG, GIF), after an ad or from the start', async () => {
    const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    const GIF = new TextEncoder().encode('GIF89a\x01\x00\x01\x00\x00\x00\x00;');
    const disguise = (prefix: Uint8Array, body: Uint8Array): Uint8Array<ArrayBuffer> => {
      const out = new Uint8Array(prefix.length + body.length);
      out.set(prefix);
      out.set(body, prefix.length);
      return out;
    };
    const muxed = media.ts.muxed;
    const plain = muxed.segments.map((body, i): StoredSegmentSpec => ({ body, duration: muxed.durations[i] ?? 2 }));
    for (const prefix of [PNG, GIF]) {
      const movie = [0, 1, 2, 3, 4].flatMap(() => muxed.segments.map((body, i): StoredSegmentSpec => ({ body: disguise(prefix, body), duration: muxed.durations[i] ?? 2, discontinuity: 1 })));
      const { storage, saves, process, probeSaved, reports } = setup();
      await storeSegments(storage, 't', [{ trackId: 'main', trackType: 'main', container: 'mpeg-ts', segments: [...plain, ...movie] }]);
      await process('t');
      expect(reports.find((report) => report.outcome)?.outcome).toBeUndefined();
      expect((await probeSaved(saves[0]))?.durationSec).toBeCloseTo(48, 0);
      // The stored segments are untouched: only what FFmpeg reads skips the picture.
      expect((await storage.trackData('t', 'main'))[muxed.segments.length]?.data.size).toBe(prefix.length + (muxed.segments[0]?.length ?? 0));
    }

    const { storage, saves, process, probeSaved } = setup();
    await storeSegments(storage, 'd', [
      { trackId: 'main', trackType: 'main', container: 'mpeg-ts', segments: muxed.segments.map((body, i) => ({ body: disguise(PNG, body), duration: muxed.durations[i] ?? 2 })) },
    ]);
    await process('d');
    expect(saves[0]?.media?.tracks[0]?.streams.map((stream) => stream.codec)).toEqual(['h264', 'aac']); // not a "png" video
    expect((await probeSaved(saves[0]))?.durationSec).toBeCloseTo(8, 0);

    // The reported stream exactly: segments named ".png" (container "unknown"), a 1×1 PNG before every
    // segment, no discontinuity. FFmpeg read one picture per segment: 750 segments came out as 30 seconds.
    const named = setup();
    const repeatedSegments = [0, 1, 2, 3, 4].flatMap(() => muxed.segments.map((body, i): StoredSegmentSpec => ({ body: disguise(PNG, body), duration: muxed.durations[i] ?? 2 })));
    await storeSegments(named.storage, 'u', [{ trackId: 'main', trackType: 'main', container: 'unknown', segments: repeatedSegments }]);
    await named.process('u');
    expect(named.reports.find((report) => report.outcome)?.outcome).toBeUndefined();
    expect(named.saves[0]?.media?.tracks[0]).toMatchObject({ format: 'mpegts', streams: [{ codec: 'h264' }, { codec: 'aac' }] });
    expect((await named.probeSaved(named.saves[0]))?.durationSec).toBeCloseTo(40, 0);
  });

  it('leaves single MPEG-TS inputs to FFmpeg, which corrects their jumps itself', async () => {
    const v = media.ts.video['v180'] as Rendition;
    const { failure, merged } = await merge('mpeg-ts', repeated(v, 5), repeated(media.ts.audio, 5));
    expect(failure).toBeUndefined();
    expect(merged?.durationSec).toBeCloseTo(40, 0);
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!condition()) throw new Error('condition not met');
}
