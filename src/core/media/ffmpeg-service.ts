import type { Logger } from '@/shared/utils/logger';
import { FfmpegError, type FfmpegJob, type FfmpegResult, type FfmpegRunner, type FfmpegRunOptions } from './ffmpeg-job';
import { parseWorkerEvent, type RunRequest } from './ffmpeg-protocol';

/** The parts of `Worker` the service uses (a fake in tests). */
export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}

export interface FfmpegServiceOptions {
  /** Starts the media worker (`new Worker(new URL(…media-worker.ts…), { type: 'module' })`). */
  createWorker(): WorkerLike;
  /** URL of ffmpeg-core.js inside the extension package. */
  coreUrl: string;
  /** The worker, and FFmpeg's heap with it, is released after this long without commands. */
  idleMs?: number;
  /** Loading FFmpeg (fetching and compiling ~32 MB of WebAssembly) must finish within this. */
  loadTimeoutMs?: number;
  logger?: Logger;
}

interface Current {
  id: number;
  options: FfmpegRunOptions;
  loadMs: number;
  started: boolean;
  resolve(result: FfmpegResult): void;
  reject(error: Error): void;
  /** Re-arms the watchdog once the command runs. */
  arm(ms: number, onExpired: () => void): void;
  /** Re-arms the progress watchdog (stallTimeoutMs). */
  armStall(): void;
}

const abortError = (): DOMException => new DOMException('FFmpeg job aborted', 'AbortError');

/** Grace period on top of a job's timeout: FFmpeg's own timer stops it cleanly first. */
const WATCHDOG_GRACE_MS = 5_000;

/**
 * FFmpeg for the offscreen document, behind a dedicated module worker so its
 * synchronous, CPU-heavy commands never block the engine's event loop (or any
 * page).
 *
 * - The worker (and FFmpeg inside it) starts with the first command and is
 *   terminated after `idleMs` without commands, which frees the WebAssembly
 *   heap: Emscripten heaps only grow.
 * - Commands run one at a time, in call order.
 * - Aborting a command, a timeout, a crash, running out of memory or failing
 *   to load all terminate the worker: FFmpeg cannot be interrupted from
 *   outside, and an instance that failed is not trusted again. The next
 *   command starts a fresh worker.
 */
export class FfmpegService implements FfmpegRunner {
  readonly #options: FfmpegServiceOptions;
  #worker: WorkerLike | undefined;
  #current: Current | undefined;
  #nextId = 0;
  #chain: Promise<unknown> = Promise.resolve();
  #queued = 0;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: FfmpegServiceOptions) {
    this.#options = options;
  }

  /** Whether a worker (with or without FFmpeg loaded) currently exists. */
  get workerAlive(): boolean {
    return this.#worker !== undefined;
  }

  run(job: FfmpegJob, options: FfmpegRunOptions = {}): Promise<FfmpegResult> {
    this.#queued += 1;
    this.#clearIdle();
    const result = this.#chain.then(() => this.#execute(job, options));
    this.#chain = result
      .catch(() => undefined)
      .finally(() => {
        this.#queued -= 1;
        if (this.#queued === 0) this.#scheduleIdle();
      });
    return result;
  }

  /** Stops the worker now; a running command fails with an AbortError. */
  terminate(): void {
    const current = this.#current;
    this.#discardWorker();
    current?.reject(abortError());
  }

  #execute(job: FfmpegJob, options: FfmpegRunOptions): Promise<FfmpegResult> {
    return new Promise<FfmpegResult>((resolve, reject) => {
      const { signal } = options;
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const worker = this.#ensureWorker();
      const id = this.#nextId++;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      let stallWatchdog: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        clearTimeout(watchdog);
        clearTimeout(stallWatchdog);
        signal?.removeEventListener('abort', onAbort);
        if (this.#current?.id === id) this.#current = undefined;
      };
      const onAbort = (): void => {
        this.#discardWorker();
        current.reject(abortError());
      };
      const current: Current = {
        id,
        options,
        loadMs: 0,
        started: false,
        resolve: (result) => {
          finish();
          resolve(result);
        },
        reject: (error) => {
          finish();
          reject(error);
        },
        arm: (ms, onExpired) => {
          clearTimeout(watchdog);
          watchdog = setTimeout(onExpired, ms);
        },
        armStall: () => {
          const stall = options.stallTimeoutMs;
          if (stall === undefined) return;
          clearTimeout(stallWatchdog);
          stallWatchdog = setTimeout(() => {
            this.#discardWorker();
            current.reject(new FfmpegError('FFmpeg stopped making progress and was stopped.', 'timeout'));
          }, stall);
        },
      };
      this.#current = current;
      signal?.addEventListener('abort', onAbort, { once: true });
      current.arm(this.#options.loadTimeoutMs ?? 120_000, () => {
        this.#discardWorker();
        current.reject(new FfmpegError('FFmpeg took too long to load.', 'load'));
      });
      const request: RunRequest = { type: 'run', id, coreUrl: this.#options.coreUrl, job };
      if (options.timeoutMs !== undefined) request.timeoutMs = options.timeoutMs;
      worker.postMessage(request);
    });
  }

  #ensureWorker(): WorkerLike {
    if (this.#worker) return this.#worker;
    const worker = this.#options.createWorker();
    worker.onmessage = (event) => {
      if (this.#worker === worker) this.#onMessage(event.data);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      if (this.#worker !== worker) return;
      const current = this.#current;
      this.#discardWorker();
      const detail = typeof event.message === 'string' && event.message !== '' ? `: ${event.message}` : '';
      current?.reject(
        current.started
          ? new FfmpegError(`FFmpeg stopped unexpectedly${detail}`, 'crashed')
          : new FfmpegError(`The media worker could not start${detail}`, 'load'),
      );
    };
    worker.onmessageerror = () => {
      if (this.#worker !== worker) return;
      const current = this.#current;
      this.#discardWorker();
      current?.reject(new FfmpegError('FFmpeg sent a result that could not be read.', 'crashed'));
    };
    this.#worker = worker;
    return worker;
  }

  #onMessage(data: unknown): void {
    const event = parseWorkerEvent(data);
    const current = this.#current;
    if (!event || !current || event.id !== current.id) return;
    switch (event.type) {
      case 'started': {
        current.started = true;
        current.loadMs = event.loadMs;
        if (event.loadMs > 0) this.#options.logger?.debug('FFmpeg loaded', { ms: event.loadMs });
        const timeout = current.options.timeoutMs;
        if (timeout === undefined) current.arm(2 ** 31 - 1, () => undefined);
        else {
          current.arm(timeout + WATCHDOG_GRACE_MS, () => {
            this.#discardWorker();
            current.reject(new FfmpegError('FFmpeg took too long and was stopped.', 'timeout'));
          });
        }
        current.armStall();
        current.options.onStarted?.();
        return;
      }
      case 'progress':
        current.armStall();
        current.options.onProgress?.(event.seconds);
        return;
      case 'done':
        current.resolve({ ...event.result, loadMs: current.loadMs });
        return;
      case 'failed':
        // Whatever failed inside FFmpeg, its instance is not reused.
        if (event.error.kind !== 'invalid-job') this.#discardWorker();
        current.reject(new FfmpegError(event.error.message, event.error.kind));
        return;
    }
  }

  #discardWorker(): void {
    this.#clearIdle();
    const worker = this.#worker;
    this.#worker = undefined;
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  }

  #scheduleIdle(): void {
    this.#clearIdle();
    if (!this.#worker) return;
    this.#idleTimer = setTimeout(() => {
      if (this.#queued === 0) this.#discardWorker();
    }, this.#options.idleMs ?? 10_000);
  }

  #clearIdle(): void {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }
}
