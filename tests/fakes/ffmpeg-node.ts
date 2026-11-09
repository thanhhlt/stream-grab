import { FfmpegError, type FfmpegJob, type FfmpegResult, type FfmpegRunner, type FfmpegRunOptions } from '@/core/media/ffmpeg-job';
import { loadFfmpegSession, type FfmpegSession, type SessionOptions } from '@/core/media/ffmpeg-session';
import { coreWasm, loadCoreFactory, SyncBlob } from '@tests/fixtures/media/node-core';

export { SyncBlob };

/** An FFmpeg session on the real core, in process (see tests/fixtures/media/node-core.ts). */
export async function loadNodeSession(options: SessionOptions = {}): Promise<FfmpegSession> {
  return loadFfmpegSession(await loadCoreFactory(), { wasmBinary: coreWasm() }, options);
}

/** Node stand-in for a mounted Blob: its bytes, readable synchronously. */
export async function syncBlob(blob: Blob): Promise<Blob> {
  return new SyncBlob(new Uint8Array(await blob.arrayBuffer())) as unknown as Blob;
}

/**
 * FfmpegRunner on the real core, in process: what the media worker does,
 * minus the thread. A session that failed is replaced, like a terminated
 * worker. `runs` counts commands, `loads` FFmpeg instances.
 */
export class NodeFfmpegRunner implements FfmpegRunner {
  runs = 0;
  loads = 0;
  readonly jobs: FfmpegJob[] = [];
  readonly #options: SessionOptions;
  #session: FfmpegSession | undefined;

  /** `options.files`: where outputs named in outputFiles go (a MemoryOutputFiles, like OPFS in the media worker). */
  constructor(options: SessionOptions = {}) {
    this.#options = options;
  }

  async run(job: FfmpegJob, options: FfmpegRunOptions = {}): Promise<FfmpegResult> {
    options.signal?.throwIfAborted();
    this.jobs.push(job);
    const inputs = await Promise.all(job.inputs.map(async (input) => ({ name: input.name, data: await syncBlob(input.data) })));
    let loadMs = 0;
    if (!this.#session) {
      const started = performance.now();
      this.#session = await loadNodeSession(this.#options);
      this.loads += 1;
      loadMs = Math.round(performance.now() - started);
    }
    options.signal?.throwIfAborted();
    options.onStarted?.();
    this.runs += 1;
    try {
      const result = await this.#session.run(
        { ...job, inputs },
        {
          ...(options.onProgress ? { onProgress: options.onProgress } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        },
      );
      options.signal?.throwIfAborted();
      return { ...result, loadMs };
    } catch (error) {
      if (error instanceof FfmpegError && error.kind !== 'invalid-job') this.#session = undefined;
      throw error;
    }
  }
}
