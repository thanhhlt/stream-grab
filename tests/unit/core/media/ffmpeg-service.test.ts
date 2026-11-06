import { afterEach, describe, expect, it, vi } from 'vitest';
import { FfmpegError, type FfmpegJob } from '@/core/media/ffmpeg-job';
import type { RunRequest, WorkerEvent } from '@/core/media/ffmpeg-protocol';
import { FfmpegService, type WorkerLike } from '@/core/media/ffmpeg-service';

/** Stands in for the media worker: records requests; the test answers them. */
class FakeWorker implements WorkerLike {
  readonly requests: RunRequest[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;

  postMessage(message: unknown): void {
    this.requests.push(message as RunRequest);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(event: WorkerEvent): void {
    this.onmessage?.({ data: event } as MessageEvent);
  }

  /** Answers the latest request: started, then done. */
  finish(stdout = '{}', loadMs = 0): void {
    const id = this.requests.at(-1)?.id ?? -1;
    this.emit({ type: 'started', id, loadMs });
    this.emit({ type: 'done', id, result: { exitCode: 0, stdout, stderrTail: [], outputs: [], runMs: 1 } });
  }

  crash(message: string): void {
    this.onerror?.({ message, preventDefault: () => undefined } as unknown as ErrorEvent);
  }
}

const job: FfmpegJob = { tool: 'ffprobe', args: ['-i', '/in/a.ts'], inputs: [{ name: 'a.ts', data: new Blob(['x']) }], outputs: [] };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(options: { idleMs?: number; loadTimeoutMs?: number } = {}) {
  const workers: FakeWorker[] = [];
  const service = new FfmpegService({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    coreUrl: 'chrome-extension://abc/ffmpeg/ffmpeg-core.js',
    ...options,
  });
  return { service, workers };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('FfmpegService', () => {
  it('starts the worker with the first command and passes the core URL and the job', async () => {
    const { service, workers } = setup();
    expect(workers).toHaveLength(0); // lazy: nothing until processing starts
    const started = vi.fn();
    const result = service.run(job, { onStarted: started, timeoutMs: 5000 });
    await flush();
    expect(workers).toHaveLength(1);
    expect(workers[0]?.requests[0]).toEqual({ type: 'run', id: 0, coreUrl: 'chrome-extension://abc/ffmpeg/ffmpeg-core.js', job, timeoutMs: 5000 });
    workers[0]?.finish('{"format":{}}', 850);
    await expect(result).resolves.toMatchObject({ stdout: '{"format":{}}', loadMs: 850, exitCode: 0 });
    expect(started).toHaveBeenCalledTimes(1);
  });

  it('runs commands one at a time in call order, on the same worker', async () => {
    const { service, workers } = setup();
    const first = service.run(job);
    const second = service.run(job);
    await flush();
    expect(workers[0]?.requests).toHaveLength(1);
    workers[0]?.finish('1');
    await expect(first).resolves.toMatchObject({ stdout: '1' });
    await flush();
    expect(workers[0]?.requests).toHaveLength(2);
    workers[0]?.finish('2');
    await expect(second).resolves.toMatchObject({ stdout: '2' });
    expect(workers).toHaveLength(1);
  });

  it('forwards progress and ignores events of other commands', async () => {
    const { service, workers } = setup();
    const progress: number[] = [];
    const result = service.run(job, { onProgress: (seconds) => progress.push(seconds) });
    await flush();
    const worker = workers[0] as FakeWorker;
    worker.emit({ type: 'progress', id: 0, seconds: 1.5 });
    worker.emit({ type: 'progress', id: 99, seconds: 7 });
    worker.emit({ type: 'progress', id: 0, seconds: 3 });
    worker.finish();
    await result;
    expect(progress).toEqual([1.5, 3]);
  });

  it('terminates the worker to abort a command; the next command gets a fresh one', async () => {
    const { service, workers } = setup();
    const controller = new AbortController();
    const result = service.run(job, { signal: controller.signal });
    await flush();
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers[0]?.terminated).toBe(true);

    const next = service.run(job);
    await flush();
    expect(workers).toHaveLength(2);
    workers[1]?.finish();
    await expect(next).resolves.toBeDefined();
  });

  it('rejects an already aborted command without starting a worker', async () => {
    const { service, workers } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(service.run(job, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers).toHaveLength(0);
  });

  it('discards the worker after FFmpeg failed (memory, crash), but not after an invalid job', async () => {
    const { service, workers } = setup();
    const result = service.run(job);
    await flush();
    workers[0]?.emit({ type: 'failed', id: 0, error: { kind: 'memory', message: 'FFmpeg ran out of memory.' } });
    await expect(result).rejects.toEqual(new FfmpegError('FFmpeg ran out of memory.', 'memory'));
    expect(workers[0]?.terminated).toBe(true);

    const invalid = service.run(job);
    await flush();
    workers[1]?.emit({ type: 'failed', id: 1, error: { kind: 'invalid-job', message: 'bad' } });
    await expect(invalid).rejects.toMatchObject({ kind: 'invalid-job' });
    expect(workers[1]?.terminated).toBe(false);
  });

  it('reports a worker that fails to start as a load error, and one that dies later as a crash', async () => {
    const { service, workers } = setup();
    const result = service.run(job);
    await flush();
    workers[0]?.crash('Failed to fetch dynamically imported module');
    await expect(result).rejects.toMatchObject({ kind: 'load', message: 'The media worker could not start: Failed to fetch dynamically imported module' });

    const later = service.run(job);
    await flush();
    workers[1]?.emit({ type: 'started', id: 1, loadMs: 0 });
    workers[1]?.crash('');
    await expect(later).rejects.toMatchObject({ kind: 'crashed', message: 'FFmpeg stopped unexpectedly' });
  });

  it('stops a command that outlives its timeout, and a load that never finishes', async () => {
    vi.useFakeTimers();
    const { service, workers } = setup({ loadTimeoutMs: 60_000 });
    const result = service.run(job, { timeoutMs: 1000 });
    const rejection = expect(result).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(0);
    workers[0]?.emit({ type: 'started', id: 0, loadMs: 10 });
    await vi.advanceTimersByTimeAsync(5999); // FFmpeg's own timer gets the first chance
    expect(workers[0]?.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(workers[0]?.terminated).toBe(true);

    const stuck = service.run(job);
    const stuckRejection = expect(stuck).rejects.toMatchObject({ kind: 'load' });
    await vi.advanceTimersByTimeAsync(60_000);
    await stuckRejection;
  });

  it('stops a command that stops making progress, however long it may run', async () => {
    vi.useFakeTimers();
    const { service, workers } = setup();
    const result = service.run(job, { stallTimeoutMs: 1000 });
    const rejection = expect(result).rejects.toMatchObject({ kind: 'timeout', message: 'FFmpeg stopped making progress and was stopped.' });
    await vi.advanceTimersByTimeAsync(0);
    const worker = workers[0] as FakeWorker;
    worker.emit({ type: 'started', id: 0, loadMs: 0 });
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(900);
      worker.emit({ type: 'progress', id: 0, seconds: i });
    }
    expect(worker.terminated).toBe(false); // 4.5 s, but progress every 0.9 s
    await vi.advanceTimersByTimeAsync(1000);
    await rejection;
    expect(worker.terminated).toBe(true);
  });

  it('releases the worker (and FFmpeg memory) once idle', async () => {
    vi.useFakeTimers();
    const { service, workers } = setup({ idleMs: 1000 });
    const result = service.run(job);
    await vi.advanceTimersByTimeAsync(0);
    workers[0]?.finish();
    await result;
    await vi.advanceTimersByTimeAsync(999);
    expect(service.workerAlive).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(service.workerAlive).toBe(false);
    expect(workers[0]?.terminated).toBe(true);
  });

  it('terminate() stops the running command', async () => {
    const { service, workers } = setup();
    const result = service.run(job);
    await flush();
    service.terminate();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers[0]?.terminated).toBe(true);
  });
});
