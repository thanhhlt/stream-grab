/**
 * The parts of `@ffmpeg/core` (FFmpeg 5.1 compiled to WebAssembly by
 * Emscripten, single-threaded build) that StreamGrab uses. The package ships
 * no typings. Its build only runs in a Web Worker (`ENVIRONMENT_IS_WORKER` is
 * hard-coded), has a 2 GiB heap limit, and includes WORKERFS, which reads
 * mounted Blobs on demand through `FileReaderSync` instead of copying them
 * into the heap.
 *
 * Behaviour verified against 0.12.10:
 * - `exec()` returns FFmpeg's exit code (0 success, 1 error) and prints
 *   "Aborted()" through the logger at the end of every run (its exit path);
 *   `onAbort` then receives an empty reason. A non-empty reason (e.g. "OOM")
 *   is a real abort and leaves the instance unusable.
 * - `ffprobe()` always returns -1: the result is its stdout (JSON with
 *   `-of json`) and errors are its stderr.
 * - An instance can run any number of commands; `reset()` clears the exit
 *   code and timeout between them.
 */

export interface FfmpegCoreLog {
  type: 'stdout' | 'stderr';
  message: string;
}

/** Emscripten file stream (opaque to callers of the FS API). */
export type EmscriptenStream = object;

/** An Emscripten FS node, as custom filesystems (SinkFs) see it. */
export interface FsNode {
  id: number;
  name: string;
  mode: number;
  parent: FsNode;
  timestamp: number;
  contents?: Record<string, FsNode>;
  node_ops: object;
  stream_ops: object;
}

/** A stream as custom filesystems see it. */
export interface FsStream {
  node: FsNode;
  position: number;
}

export interface EmscriptenFs {
  mkdir(path: string): void;
  rmdir(path: string): void;
  readdir(path: string): string[];
  unlink(path: string): void;
  stat(path: string): { size: number; mode: number };
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
  /** Creates a node of a custom filesystem (inside its mount() and mknod()). */
  createNode(parent: FsNode | null, name: string, mode: number, dev: number): FsNode;
  /** Error type the FS layer turns into errno results (e.g. 29 EIO, 44 ENOENT). */
  ErrnoError: new (errno: number) => Error;
  analyzePath(path: string): { exists: boolean };
  /** WORKERFS options: Blobs (or Files) to expose read-only under the mount point. */
  mount(type: unknown, options: { blobs?: { name: string; data: Blob }[] }, mountPoint: string): unknown;
  unmount(mountPoint: string): void;
  open(path: string, flags: string): EmscriptenStream;
  read(stream: EmscriptenStream, buffer: Uint8Array, offset: number, length: number, position?: number): number;
  close(stream: EmscriptenStream): void;
  writeFile(path: string, data: Uint8Array | string): void;
  readFile(path: string): Uint8Array;
  filesystems: { MEMFS: unknown; WORKERFS: unknown };
}

export interface FfmpegCore {
  exec(...args: string[]): number;
  ffprobe(...args: string[]): number;
  setLogger(logger: (log: FfmpegCoreLog) => void): void;
  /** `time` is the output position in microseconds; the core's `progress` ratio is unreliable. */
  setProgress(handler: (progress: { progress: number; time: number }) => void): void;
  /** Stops the next exec() after this many milliseconds (-1: no limit). Cleared by reset(). */
  setTimeout(ms: number): void;
  reset(): void;
  FS: EmscriptenFs;
}

export interface FfmpegCoreOptions {
  /** The WebAssembly module's bytes; without it the core fetches `ffmpeg-core.wasm` next to its script. */
  wasmBinary?: ArrayBuffer | Uint8Array;
  /** Called with the reason of every abort: empty after each normal run, e.g. "OOM" for a real one. */
  onAbort?: (reason: unknown) => void;
}

/** Default export of `ffmpeg-core.js`. */
export type CreateFfmpegCore = (options?: FfmpegCoreOptions) => Promise<FfmpegCore>;

export function isCreateFfmpegCore(value: unknown): value is CreateFfmpegCore {
  return typeof value === 'function';
}
