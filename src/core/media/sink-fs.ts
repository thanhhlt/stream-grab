import type { EmscriptenFs, FsNode, FsStream } from './ffmpeg-core';
import { BlobSink, SinkError, type OutputSink, type SinkOptions } from './output-sink';

const DIR_MODE = 0o40777;
const EIO = 29;
const EINVAL = 28;
const ENOENT = 44;
const EPERM = 63;

interface SinkNode extends FsNode {
  sink?: OutputSink;
}

/**
 * An Emscripten filesystem whose files are OutputSinks, mounted where FFmpeg
 * writes its outputs. Files are created by FFmpeg (open with O_CREAT), live
 * until unlinked, and can be handed over without copying them out of a heap:
 * a file prepared for the command (a FileSink on disk) or, by default, a
 * BlobSink. Only regular files directly in the mount point are supported;
 * that is all a muxer needs.
 */
export class SinkFs {
  /** Files by name, as FFmpeg created them. */
  readonly files = new Map<string, OutputSink>();
  readonly #fs: EmscriptenFs;
  readonly #options: SinkOptions;
  #prepared: ReadonlyMap<string, OutputSink> = new Map();

  constructor(fs: EmscriptenFs, options: SinkOptions = {}) {
    this.#fs = fs;
    this.#options = options;
  }

  /** Sinks the next files of these names are created on (for one command; an empty map ends it). */
  prepare(sinks: ReadonlyMap<string, OutputSink>): void {
    this.#prepared = sinks;
  }

  /** The filesystem type, for `FS.mount(sinkFs.type, {}, '/out')`. */
  get type(): { mount(mount: unknown): FsNode } {
    return { mount: () => this.#createNode(null, '/', DIR_MODE) };
  }

  #createNode(parent: SinkNode | null, name: string, mode: number): SinkNode {
    const fs = this.#fs;
    const node = fs.createNode(parent, name, mode, 0) as SinkNode;
    node.node_ops = this.#nodeOps;
    node.stream_ops = this.#streamOps;
    node.timestamp = Date.now();
    if (fs.isDir(mode)) {
      node.contents = {};
    } else {
      const prepared = this.#prepared.get(name);
      // Created again after an unlink: it starts empty, like any new file.
      if (prepared && prepared.size > 0) this.#guard(() => prepared.truncate(0));
      const sink = prepared ?? new BlobSink(this.#options);
      node.sink = sink;
      this.files.set(name, sink);
    }
    if (parent?.contents) parent.contents[name] = node;
    return node;
  }

  #error(code: number): Error {
    return new this.#fs.ErrnoError(code);
  }

  #sinkOf(node: FsNode): OutputSink {
    const { sink } = node as SinkNode;
    if (!sink) throw this.#error(EINVAL);
    return sink;
  }

  readonly #nodeOps = {
    getattr: (node: SinkNode) => {
      const size = node.sink?.size ?? 4096;
      const time = new Date(node.timestamp);
      return { dev: 1, ino: node.id, mode: node.mode, nlink: 1, uid: 0, gid: 0, rdev: 0, size, atime: time, mtime: time, ctime: time, blksize: 4096, blocks: Math.ceil(size / 4096) };
    },
    setattr: (node: SinkNode, attr: { mode?: number; timestamp?: number; size?: number }) => {
      if (attr.mode !== undefined) node.mode = attr.mode;
      if (attr.timestamp !== undefined) node.timestamp = attr.timestamp;
      if (attr.size !== undefined) this.#guard(() => this.#sinkOf(node).truncate(attr.size ?? 0));
    },
    lookup: () => {
      throw this.#error(ENOENT);
    },
    mknod: (parent: SinkNode, name: string, mode: number) => {
      if (!this.#fs.isFile(mode) || !parent.contents) throw this.#error(EPERM);
      return this.#createNode(parent, name, mode);
    },
    unlink: (parent: SinkNode, name: string) => {
      if (parent.contents) delete parent.contents[name];
      this.files.delete(name);
    },
    readdir: (node: SinkNode) => ['.', '..', ...Object.keys(node.contents ?? {})],
    rename: () => {
      throw this.#error(EPERM);
    },
    rmdir: () => {
      throw this.#error(EPERM);
    },
    symlink: () => {
      throw this.#error(EPERM);
    },
  };

  readonly #streamOps = {
    read: (stream: FsStream, buffer: Int8Array | Uint8Array, offset: number, length: number, position: number) => {
      const target = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
      return this.#guard(() => this.#sinkOf(stream.node).read(target, position));
    },
    write: (stream: FsStream, buffer: Int8Array | Uint8Array, offset: number, length: number, position: number) => {
      // `buffer` is the WebAssembly heap: the sink copies (or writes out) what it keeps.
      const data = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
      this.#guard(() => {
        this.#sinkOf(stream.node).write(data, position);
      });
      return length;
    },
    llseek: (stream: FsStream, offset: number, whence: number) => {
      const base = whence === 1 ? stream.position : whence === 2 ? (this.#sinkOf(stream.node).size) : 0;
      const position = base + offset;
      if (position < 0) throw this.#error(EINVAL);
      return position;
    },
  };

  /** Turns a refused or failed access into the I/O error FFmpeg understands. */
  #guard<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof SinkError) throw this.#error(EIO);
      throw error;
    }
  }
}
