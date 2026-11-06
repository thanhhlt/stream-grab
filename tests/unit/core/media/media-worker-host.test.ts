import { describe, expect, it, vi } from 'vitest';
import type { FfmpegJob, FfmpegRunResult } from '@/core/media/ffmpeg-job';
import { FfmpegError } from '@/core/media/ffmpeg-job';
import type { WorkerEvent } from '@/core/media/ffmpeg-protocol';
import type { FfmpegSession, SessionRunOptions } from '@/core/media/ffmpeg-session';
import { MediaWorkerHost } from '@/core/media/media-worker-host';

const job: FfmpegJob = { tool: 'ffprobe', args: ['-i', '/in/a.ts'], inputs: [{ name: 'a.ts', data: new Blob(['x']) }], outputs: [] };
const result: FfmpegRunResult = { exitCode: undefined, stdout: '{}', stderrTail: [], outputs: [], runMs: 3 };
const request = (id: number) => ({ type: 'run', id, coreUrl: 'chrome-extension://abc/ffmpeg/ffmpeg-core.js', job });

function setup(run: (job: FfmpegJob, options: SessionRunOptions) => FfmpegRunResult = () => result) {
  const events: WorkerEvent[] = [];
  const session = { run: vi.fn(run) } as unknown as FfmpegSession;
  const load = vi.fn(() => Promise.resolve(session));
  let clock = 0;
  const host = new MediaWorkerHost({
    load,
    post: (event) => events.push(event),
    now: () => (clock += 500),
  });
  return { host, events, load, session };
}

describe('MediaWorkerHost', () => {
  it('loads FFmpeg on the first command only and reports started, progress, done', async () => {
    const { host, events, load } = setup((_, options) => {
      options.onProgress?.(1.5);
      return result;
    });
    await host.handle(request(1));
    await host.handle(request(2));
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('chrome-extension://abc/ffmpeg/ffmpeg-core.js');
    expect(events).toEqual([
      { type: 'started', id: 1, loadMs: 500 },
      { type: 'progress', id: 1, seconds: 1.5 },
      { type: 'done', id: 1, result },
      { type: 'started', id: 2, loadMs: 500 },
      { type: 'progress', id: 2, seconds: 1.5 },
      { type: 'done', id: 2, result },
    ]);
  });

  it('reports a load failure, and tries loading again for the next command', async () => {
    const { host, events, load, session } = setup();
    load.mockRejectedValueOnce(new Error('CompileError: WebAssembly.instantiate(): out of memory'));
    await host.handle(request(1));
    expect(events).toEqual([
      { type: 'failed', id: 1, error: { kind: 'load', message: 'FFmpeg could not be loaded: CompileError: WebAssembly.instantiate(): out of memory' } },
    ]);
    load.mockResolvedValueOnce(session);
    await host.handle(request(2));
    expect(events.at(-1)).toEqual({ type: 'done', id: 2, result });
  });

  it('passes FFmpeg errors on with their kind', async () => {
    const { host, events } = setup(() => {
      throw new FfmpegError('FFmpeg ran out of memory.', 'memory');
    });
    await host.handle(request(1));
    expect(events.at(-1)).toEqual({ type: 'failed', id: 1, error: { kind: 'memory', message: 'FFmpeg ran out of memory.' } });
  });

  it('answers malformed requests with an error when it can tell which one it was', async () => {
    const { host, events, load } = setup();
    await host.handle({ type: 'run', id: 4, coreUrl: 'x', job: { tool: 'bash' } });
    await host.handle('garbage');
    expect(events).toEqual([{ type: 'failed', id: 4, error: { kind: 'invalid-job', message: 'Invalid FFmpeg request' } }]);
    expect(load).not.toHaveBeenCalled();
  });
});
