import type { EmscriptenFs, FsNode, FsStream } from './ffmpeg-core';
import { BlobSink, SinkAccessError, type SinkOptions } from './output-sink';

const DIR_MODE = 0o40777;
const EIO = 29;
const EINVAL = 28;
const ENOENT = 44;
const EPERM = 63;

interface SinkNode extends FsNode {
  sink?: BlobSink;
}

/**
 * An Emscripten filesystem whose files are BlobSinks, mounted where FFmpeg
 * writes its outputs. Files are created by FFmpeg (open with O_CREAT), live
 * until unlinked, and can be handed over as Blobs without copying them out of
 * a heap. Only regular files directly in the mount point are supported; that
 * is all a muxer needs.
 */
export class SinkFs {
  /** Files by name, as FFmpeg created them. */
  readonly files = new Map<string, BlobSink>();
  readonly #fs: EmscriptenFs;
  readonly #options: SinkOptions;

  constructor(fs: EmscriptenFs, options: SinkOptions = {}) {
    this.#fs = fs;
    this.#options = options;
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
      const sink = new BlobSink(this.#options);
      node.sink = sink;
      this.files.set(name, sink);
    }
    if (parent?.contents) parent.contents[name] = node;
    return node;
  }

  #error(code: number): Error {
    return new this.#fs.ErrnoError(code);
  }

  #sinkOf(node: FsNode): BlobSink {
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
      // `buffer` is the WebAssembly heap: the sink copies what it keeps.
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

  /** Turns a refused access into the I/O error FFmpeg understands. */
  #guard<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof SinkAccessError) throw this.#error(EIO);
      throw error;
    }
  }
}
