/**
 * What media processing asks of FFmpeg, independent of where FFmpeg runs (a
 * Web Worker in the extension, in process in tests).
 *
 * A job runs one command. Its inputs are Blobs mounted read-only under
 * INPUT_DIR (InputFs: FFmpeg reads them on demand, they are never copied
 * into the WebAssembly heap); the files it names in `outputs` are written to
 * OUTPUT_DIR (SinkFs) and handed back as Blobs: into a file on disk when the
 * job names one in `outputFiles` (output-files.ts), otherwise streamed into
 * Blob parts.
 */

export const INPUT_DIR = '/in';
export const OUTPUT_DIR = '/out';

export type FfmpegTool = 'ffmpeg' | 'ffprobe';

export interface FfmpegInput {
  /** File name (no directories): FILE_NAME. */
  name: string;
  data: Blob;
}

export interface FfmpegJob {
  tool: FfmpegTool;
  /** Arguments after the program name; reference files with inputPath() and outputPath(). */
  args: string[];
  inputs: FfmpegInput[];
  /** Names of the files under OUTPUT_DIR to return. */
  outputs: string[];
  /**
   * Outputs written to a file on disk (the origin private file system's
   * MERGE_DIRECTORY): output name → file name (FILE_NAME). The file is
   * created or emptied before the command and handed back as a File; a failed
   * command deletes it, otherwise the caller does. When the file cannot be
   * opened, the output streams into Blob parts instead.
   */
  outputFiles?: Record<string, string>;
}

export interface FfmpegOutput {
  name: string;
  data: Blob;
  /** The file on disk `data` is (outputFiles). */
  file?: string;
  /** Why the file named in outputFiles could not be used (the output streamed into Blob parts). */
  fileError?: string;
}

/** What a command produced. A non-zero exit code is a result, not an exception: the caller words it. */
export interface FfmpegRunResult {
  /** FFmpeg's exit code; undefined for ffprobe, whose WebAssembly build reports none. */
  exitCode: number | undefined;
  /** Standard output (ffprobe's JSON), capped. */
  stdout: string;
  /** The last lines of standard error, for diagnostics and error messages. */
  stderrTail: string[];
  outputs: FfmpegOutput[];
  runMs: number;
}

export interface FfmpegResult extends FfmpegRunResult {
  /** Time spent loading FFmpeg before this job (0 when it was already loaded). */
  loadMs: number;
}

export interface FfmpegRunOptions {
  signal?: AbortSignal;
  /** Called once FFmpeg is loaded and the command starts. */
  onStarted?: () => void;
  /** Output position in seconds while an ffmpeg command runs. */
  onProgress?: (seconds: number) => void;
  /** The command is stopped (and the FFmpeg instance discarded) after this long. */
  timeoutMs?: number;
  /**
   * The command is stopped when FFmpeg reports no progress for this long, for
   * commands whose length depends on the input (a merge of a long video).
   */
  stallTimeoutMs?: number;
}

/** Runs FFmpeg commands one at a time. */
export interface FfmpegRunner {
  run(job: FfmpegJob, options?: FfmpegRunOptions): Promise<FfmpegResult>;
}

export const FFMPEG_ERROR_KINDS = ['load', 'memory', 'disk', 'timeout', 'crashed', 'invalid-job'] as const;
export type FfmpegErrorKind = (typeof FFMPEG_ERROR_KINDS)[number];

/**
 * FFmpeg itself failed, as opposed to a command that ran and reported an
 * error: it could not be loaded, ran out of memory or disk space, hung, or
 * crashed.
 */
export class FfmpegError extends Error {
  readonly kind: FfmpegErrorKind;

  constructor(message: string, kind: FfmpegErrorKind, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FfmpegError';
    this.kind = kind;
  }
}

export const MEMORY_MESSAGE =
  'FFmpeg ran out of memory. The browser gives it at most 2 GB, which this video does not fit in.';

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidFileName(name: string): boolean {
  return FILE_NAME.test(name) && !name.includes('..');
}

export const inputPath = (name: string): string => `${INPUT_DIR}/${name}`;
export const outputPath = (name: string): string => `${OUTPUT_DIR}/${name}`;

/** Text FFmpeg prints when an allocation fails, and what WebAssembly throws when the heap cannot grow. */
const MEMORY_SIGNS = [/cannot allocate memory/i, /out of memory/i, /\bOOM\b/, /array buffer allocation failed/i, /memory access out of bounds/i, /Memory\.grow/];

export function looksLikeMemoryFailure(text: string): boolean {
  return MEMORY_SIGNS.some((sign) => sign.test(text));
}

/** The most useful line of an FFmpeg error output: the last one that is not progress noise. */
export function lastErrorLine(stderr: readonly string[]): string | undefined {
  for (let i = stderr.length - 1; i >= 0; i--) {
    const line = stderr[i]?.trim() ?? '';
    if (line === '' || /^Aborted\(/.test(line) || /^(frame|size)=/.test(line)) continue;
    return line;
  }
  return undefined;
}
