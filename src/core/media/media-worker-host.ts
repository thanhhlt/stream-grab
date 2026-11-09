import { errorMessage } from '@/shared/utils/errors';
import { FfmpegError } from './ffmpeg-job';
import { parseRunRequest, type SerializedFfmpegError, type WorkerEvent } from './ffmpeg-protocol';
import type { FfmpegSession } from './ffmpeg-session';

export interface MediaWorkerHostDeps {
  /** Loads FFmpeg from the extension's ffmpeg-core.js (the worker imports it dynamically). */
  load(coreUrl: string): Promise<FfmpegSession>;
  post(event: WorkerEvent): void;
  now?: () => number;
}

/**
 * The media worker's logic: FFmpeg is loaded on the first command, not when
 * the worker starts (about 32 MB of WebAssembly to compile), and kept for the
 * next ones. Commands run one after another; FFmpeg's exec() is synchronous,
 * so the worker cannot even receive messages while one runs. Stopping a
 * command therefore means terminating the worker (FfmpegService does that).
 */
export class MediaWorkerHost {
  readonly #deps: MediaWorkerHostDeps;
  readonly #now: () => number;
  #session: Promise<FfmpegSession> | undefined;
  #chain: Promise<void> = Promise.resolve();

  constructor(deps: MediaWorkerHostDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => performance.now());
  }

  handle(raw: unknown): Promise<void> {
    this.#chain = this.#chain.then(() => this.#handle(raw));
    return this.#chain;
  }

  async #handle(raw: unknown): Promise<void> {
    const request = parseRunRequest(raw);
    if (!request) {
      const id = typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'number' ? raw.id : -1;
      if (id >= 0) this.#deps.post({ type: 'failed', id, error: { kind: 'invalid-job', message: 'Invalid FFmpeg request' } });
      return;
    }
    const { id } = request;
    try {
      const started = this.#now();
      const session = await this.#load(request.coreUrl);
      this.#deps.post({ type: 'started', id, loadMs: Math.round(this.#now() - started) });
      const result = await session.run(request.job, {
        onProgress: (seconds) => {
          this.#deps.post({ type: 'progress', id, seconds });
        },
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      });
      this.#deps.post({ type: 'done', id, result });
    } catch (error) {
      this.#deps.post({ type: 'failed', id, error: serialize(error) });
    }
  }

  async #load(coreUrl: string): Promise<FfmpegSession> {
    this.#session ??= this.#deps.load(coreUrl);
    try {
      return await this.#session;
    } catch (error) {
      this.#session = undefined;
      throw new FfmpegError(`FFmpeg could not be loaded: ${errorMessage(error)}`, 'load', { cause: error });
    }
  }
}

function serialize(error: unknown): SerializedFfmpegError {
  if (error instanceof FfmpegError) return { kind: error.kind, message: error.message };
  return { kind: 'crashed', message: `FFmpeg failed: ${errorMessage(error)}` };
}
