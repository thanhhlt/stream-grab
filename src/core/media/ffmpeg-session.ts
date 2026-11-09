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
import { errorMessage } from '@/shared/utils/errors';
import { InputFs, type InputFsOptions } from './input-fs';
import type { OutputFile, OutputFileStore } from './output-files';
import { BlobSink, FileSink, SinkStorageError, type SinkError, type SinkOptions } from './output-sink';
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
  /** Where outputs named in a job's `outputFiles` are written (the media worker: OPFS); without it they stream into Blob parts. */
  files?: Pick<OutputFileStore, 'open' | 'remove'>;
  /** How inputs are read from their Blobs (see InputFs). */
  input?: InputFsOptions;
  now?: () => number;
}

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
 * chunks, never copied into the heap whole); outputs go to /out, a SinkFs.
 * An output the job names in `outputFiles` is written to a file on disk
 * (opened before FFmpeg starts, since FFmpeg's file calls are synchronous and
 * opening is not) and handed back as its File; any other output streams into
 * Blob parts as FFmpeg writes it (only the file's start and a recent window
 * stay in memory). Either way a merged file of any size is handed over
 * without a copy in memory. Afterwards /in is unmounted, /out emptied, the
 * files closed and those of a failed command deleted. Logging and progress
 * handlers are scoped to the command.
 *
 * After an abort (out of memory) or an exception thrown by the WebAssembly
 * code the instance is in an undefined state: the session refuses further
 * commands, and the owner discards it (terminates the worker).
 */
export class FfmpegSession {
  readonly #core: FfmpegCore;
  readonly #options: Required<Omit<SessionOptions, 'sink' | 'input' | 'files'>>;
  readonly #outputs: SinkFs;
  readonly #inputs: InputFs;
  readonly #files: SessionOptions['files'];
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
    this.#files = options.files;
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

  /** Runs one command; the caller waits for it before starting the next. */
  async run(job: FfmpegJob, options: SessionRunOptions = {}): Promise<FfmpegRunResult> {
    if (this.#broken !== undefined) throw new FfmpegError(`FFmpeg stopped after an earlier error: ${this.#broken}`, 'crashed');
    validateJob(job);
    const files = await this.#openFiles(job.outputFiles);
    try {
      return await this.#execute(job, options, files);
    } finally {
      await this.#closeFiles(files);
    }
  }

  async #execute(job: FfmpegJob, options: SessionRunOptions, files: ReadonlyMap<string, PreparedFile>): Promise<FfmpegRunResult> {
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
      const sinks = new Map<string, FileSink>();
      for (const [output, file] of files) if (file.sink) sinks.set(output, file.sink);
      this.#outputs.prepare(sinks);
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
        const failed = [...this.#outputs.files.values()].find((sink) => sink.failure)?.failure;
        if (failed) throw sinkFailure(failed);
      }
      const outputs = exitCode === 0 ? await this.#collectOutputs(job.outputs, files, stderr) : [];
      return { exitCode, stdout, stderrTail: [...stderr], outputs, runMs };
    } finally {
      core.setLogger(() => undefined);
      core.setProgress(() => undefined);
      this.#outputs.prepare(new Map());
      if (this.#broken === undefined) this.#cleanUp(mounted);
    }
  }

  async #collectOutputs(names: readonly string[], files: ReadonlyMap<string, PreparedFile>, stderr: string[]): Promise<FfmpegOutput[]> {
    const outputs: FfmpegOutput[] = [];
    for (const name of names) {
      const sink = this.#outputs.files.get(name);
      if (!sink) throw new FfmpegError(`FFmpeg finished without writing ${name}.`, 'crashed');
      const prepared = files.get(name);
      if (prepared?.file && prepared.sink && sink === prepared.sink) {
        // Written out and released before it is read: a File read from an open file may not stay valid.
        prepared.sink.close();
        if (prepared.sink.failure) throw sinkFailure(prepared.sink.failure);
        let data: Blob;
        try {
          data = await prepared.file.read();
        } catch (error) {
          throw new FfmpegError(`The merged file could not be read back: ${errorMessage(error)}`, 'crashed', { cause: error });
        }
        outputs.push({ name, data, file: prepared.name });
        prepared.kept = true;
        continue;
      }
      // Some muxers ignore a failed read-back (MP4 "faststart") and still exit with 0: the file would be damaged.
      if (sink.failure) throw sinkFailure(sink.failure);
      if (!(sink instanceof BlobSink)) throw new FfmpegError(`Internal error: ${name} has no data.`, 'crashed');
      try {
        outputs.push({ name, data: sink.toBlob(), ...(prepared?.error !== undefined ? { fileError: prepared.error } : {}) });
      } catch (error) {
        throw this.#fail(error, stderr);
      }
    }
    return outputs;
  }

  /** Opens the files outputs are written to; one that cannot be opened is noted, and its output streams into Blob parts. */
  async #openFiles(outputFiles: Readonly<Record<string, string>> | undefined): Promise<Map<string, PreparedFile>> {
    const prepared = new Map<string, PreparedFile>();
    for (const [output, name] of Object.entries(outputFiles ?? {})) {
      const entry: PreparedFile = { name, kept: false };
      prepared.set(output, entry);
      if (!this.#files) {
        entry.error = 'files on disk are not available here';
        continue;
      }
      try {
        entry.file = await this.#files.open(name);
        entry.sink = new FileSink(entry.file.handle);
      } catch (error) {
        entry.error = errorMessage(error);
      }
    }
    return prepared;
  }

  /** Releases the files and deletes those not handed back (a failed command, or one that could not be opened). */
  async #closeFiles(files: ReadonlyMap<string, PreparedFile>): Promise<void> {
    for (const file of files.values()) {
      file.sink?.close();
      if (!file.kept && this.#files) await this.#files.remove(file.name).catch(() => undefined);
    }
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

/** A file a command writes to disk (outputFiles). */
interface PreparedFile {
  /** Its name on disk. */
  name: string;
  file?: OutputFile;
  sink?: FileSink;
  /** Why it could not be opened. */
  error?: string;
  /** Handed back to the caller, who deletes it. */
  kept: boolean;
}

/** An output access that failed, in the user's terms. */
function sinkFailure(cause: SinkError): FfmpegError {
  if (cause instanceof SinkStorageError) return new FfmpegError(`${cause.message}.`, cause.diskFull ? 'disk' : 'crashed', { cause });
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
  const files = new Set<string>();
  for (const [output, file] of Object.entries(job.outputFiles ?? {})) {
    if (!job.outputs.includes(output)) throw invalid(`a file for "${output}", which is not an output`);
    if (typeof file !== 'string' || !isValidFileName(file) || files.has(file)) throw invalid(`output file name "${String(file)}"`);
    files.add(file);
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
