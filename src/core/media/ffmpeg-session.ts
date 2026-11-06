import type { CreateFfmpegCore, FfmpegCore, FfmpegCoreOptions } from './ffmpeg-core';
import {
  FfmpegError,
  INPUT_DIR,
  isValidFileName,
  looksLikeMemoryFailure,
  MEMORY_MESSAGE,
  OUTPUT_DIR,
  outputPath,
  type FfmpegJob,
  type FfmpegOutput,
  type FfmpegRunResult,
} from './ffmpeg-job';
import { InputFs, type InputFsOptions } from './input-fs';
import type { SinkOptions } from './output-sink';
import { SinkFs } from './sink-fs';

export interface SessionRunOptions {
  /** Output position in seconds (ffmpeg commands). */
  onProgress?: (seconds: number) => void;
  /** FFmpeg stops the command after this long (it exits with an error). */
  timeoutMs?: number;
}

export interface SessionOptions {
  /** Standard output kept per command. */
  maxStdoutChars?: number;
  /** Standard error lines kept per command. */
  stderrLines?: number;
  /** How outputs are buffered on their way into Blobs (see BlobSink). */
  sink?: SinkOptions;
  /** How inputs are read from their Blobs (see InputFs). */
  input?: InputFsOptions;
  now?: () => number;
}

/** Inputs per command: one per track, or one per run of a track joined with the concat demuxer. */
/**
 * Mounted inputs per command. A merge mounts one per run, and a track whose
 * timestamps go back at every segment is one run per segment (media-merge.ts):
 * a 4-hour video of 4-second segments with separate audio needs about 7 200.
 */
const MAX_INPUTS = 8192;
const MAX_ARGS = 1024;

/**
 * One loaded FFmpeg instance, running one command at a time. Runs inside the
 * media worker (and in process in tests); it never touches the network or
 * IndexedDB, only the Blobs it is given.
 *
 * Per command: inputs are mounted under /in (InputFs: read on demand in large
 * chunks, never copied into the heap whole); outputs go to /out, a SinkFs whose files
 * stream into Blob parts as FFmpeg writes them (only the file's start and a
 * recent window stay in memory), so a merged file of any size is handed over
 * as a Blob without a copy in memory. Afterwards /in is unmounted and /out
 * emptied. Logging and progress handlers are scoped to the command.
 *
 * After an abort (out of memory) or an exception thrown by the WebAssembly
 * code the instance is in an undefined state: the session refuses further
 * commands, and the owner discards it (terminates the worker).
 */
export class FfmpegSession {
  readonly #core: FfmpegCore;
  readonly #options: Required<Omit<SessionOptions, 'sink' | 'input'>>;
  readonly #outputs: SinkFs;
  readonly #inputs: InputFs;
  #broken: string | undefined;
  #abortReason: string | undefined;

  constructor(core: FfmpegCore, options: SessionOptions = {}) {
    this.#core = core;
    this.#options = {
      maxStdoutChars: options.maxStdoutChars ?? 1024 * 1024,
      stderrLines: options.stderrLines ?? 40,
      now: options.now ?? (() => performance.now()),
    };
    const fs = core.FS;
    for (const dir of [INPUT_DIR, OUTPUT_DIR]) {
      if (!fs.analyzePath(dir).exists) fs.mkdir(dir);
    }
    this.#outputs = new SinkFs(fs, options.sink);
    fs.mount(this.#outputs.type, {}, OUTPUT_DIR);
    this.#inputs = new InputFs(fs, options.input);
  }

  /** Whether the instance can still run commands. */
  get usable(): boolean {
    return this.#broken === undefined;
  }

  /** Abort reason reported by the core (empty after every normal run). */
  aborted(reason: unknown): void {
    const text = typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : '';
    if (text !== '') this.#abortReason = text;
  }

  /** The abort reported during the last command, if any (set from the core's callback). */
  #takeAbort(): string | undefined {
    const reason = this.#abortReason;
    this.#abortReason = undefined;
    return reason;
  }

  run(job: FfmpegJob, options: SessionRunOptions = {}): FfmpegRunResult {
    if (this.#broken !== undefined) throw new FfmpegError(`FFmpeg stopped after an earlier error: ${this.#broken}`, 'crashed');
    validateJob(job);
    const core = this.#core;
    const fs = core.FS;
    const { maxStdoutChars, stderrLines, now } = this.#options;

    let stdout = '';
    let stdoutFull = false;
    const stderr: string[] = [];
    core.setLogger(({ type, message }) => {
      if (type === 'stdout') {
        if (stdoutFull) return;
        if (stdout.length + message.length + 1 > maxStdoutChars) {
          stdoutFull = true;
          return;
        }
        stdout += `${message}\n`;
      } else {
        stderr.push(message);
        if (stderr.length > stderrLines) stderr.shift();
      }
    });
    core.setProgress(({ time }) => {
      if (Number.isFinite(time) && time >= 0) options.onProgress?.(time / 1_000_000);
    });

    let mounted = false;
    const started = now();
    try {
      if (job.inputs.length > 0) {
        fs.mount(this.#inputs.type, { blobs: job.inputs.map((input) => ({ name: input.name, data: input.data })) }, INPUT_DIR);
        mounted = true;
      }
      core.reset();
      if (options.timeoutMs !== undefined) core.setTimeout(Math.max(1, Math.round(options.timeoutMs)));
      this.#takeAbort();

      let code: number;
      try {
        code = job.tool === 'ffmpeg' ? core.exec(...job.args) : core.ffprobe(...job.args);
      } catch (error) {
        throw this.#fail(error, stderr);
      }
      const abort = this.#takeAbort();
      if (abort !== undefined) throw this.#fail(new Error(`Aborted(${abort})`), stderr);

      const runMs = now() - started;
      const exitCode = job.tool === 'ffmpeg' ? code : undefined;
      if (exitCode !== undefined && exitCode !== 0) {
        if (options.timeoutMs !== undefined && runMs >= options.timeoutMs) {
          throw new FfmpegError('FFmpeg took too long and was stopped.', 'timeout');
        }
        if (looksLikeMemoryFailure(stderr.join('\n'))) throw new FfmpegError(MEMORY_MESSAGE, 'memory');
        const refused = [...this.#outputs.files.values()].find((sink) => sink.failure)?.failure;
        if (refused) throw streamingFailure(refused);
      }
      const outputs = exitCode === 0 ? this.#collectOutputs(job.outputs, stderr) : [];
      return { exitCode, stdout, stderrTail: [...stderr], outputs, runMs };
    } finally {
      core.setLogger(() => undefined);
      core.setProgress(() => undefined);
      if (this.#broken === undefined) this.#cleanUp(mounted);
    }
  }

  #collectOutputs(names: readonly string[], stderr: string[]): FfmpegOutput[] {
    const outputs: FfmpegOutput[] = [];
    for (const name of names) {
      const sink = this.#outputs.files.get(name);
      if (!sink) throw new FfmpegError(`FFmpeg finished without writing ${name}.`, 'crashed');
      // Some muxers ignore a failed read-back (MP4 "faststart") and still exit with 0: the file would be damaged.
      if (sink.failure) throw streamingFailure(sink.failure);
      try {
        outputs.push({ name, data: sink.toBlob() });
      } catch (error) {
        throw this.#fail(error, stderr);
      }
    }
    return outputs;
  }

  /** Unmounts the inputs and deletes whatever is left in /out (outputs of a failed command, extra files). */
  #cleanUp(mounted: boolean): void {
    const fs = this.#core.FS;
    try {
      if (mounted) fs.unmount(INPUT_DIR);
      for (const name of fs.readdir(OUTPUT_DIR)) {
        if (name === '.' || name === '..') continue;
        const path = outputPath(name);
        if (!fs.isDir(fs.stat(path).mode)) fs.unlink(path);
      }
    } catch (error) {
      this.#broken = `could not clean up: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** The instance is unusable from here on; says why in the user's terms. */
  #fail(error: unknown, stderr: readonly string[]): FfmpegError {
    const message = error instanceof Error ? error.message : String(error);
    this.#broken = message;
    if (looksLikeMemoryFailure(`${message}\n${stderr.join('\n')}`) || error instanceof RangeError) {
      return new FfmpegError(MEMORY_MESSAGE, 'memory', { cause: error });
    }
    return new FfmpegError(`FFmpeg crashed: ${message}`, 'crashed', { cause: error });
  }
}

function streamingFailure(cause: Error): FfmpegError {
  return new FfmpegError(`${cause.message}; this output cannot be written as a stream.`, 'crashed', { cause });
}

function validateJob(job: FfmpegJob): void {
  const invalid = (reason: string): FfmpegError => new FfmpegError(`Invalid FFmpeg job: ${reason}`, 'invalid-job');
  if (job.tool !== 'ffmpeg' && job.tool !== 'ffprobe') throw invalid('unknown tool');
  if (job.args.length === 0 || job.args.length > MAX_ARGS || job.args.some((arg) => typeof arg !== 'string')) throw invalid('arguments');
  if (job.inputs.length > MAX_INPUTS) throw invalid('too many inputs');
  const names = new Set<string>();
  for (const name of [...job.inputs.map((input) => input.name), ...job.outputs]) {
    if (!isValidFileName(name)) throw invalid(`file name "${name}"`);
    if (names.has(name)) throw invalid(`duplicate file name "${name}"`);
    names.add(name);
  }
}

/** Instantiates the core and wraps it; abort reports reach the session. */
export async function loadFfmpegSession(
  create: CreateFfmpegCore,
  coreOptions: Omit<FfmpegCoreOptions, 'onAbort'> = {},
  sessionOptions: SessionOptions = {},
): Promise<FfmpegSession> {
  // The core calls onAbort while it runs, so the session it reports to is created right after it.
  const target: { session?: FfmpegSession } = {};
  const core = await create({
    ...coreOptions,
    onAbort: (reason) => {
      target.session?.aborted(reason);
    },
  });
  const session = new FfmpegSession(core, sessionOptions);
  target.session = session;
  return session;
}
