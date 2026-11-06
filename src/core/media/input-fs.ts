import type { EmscriptenFs, FsNode, FsStream } from './ffmpeg-core';

const DIR_MODE = 0o40555;
const FILE_MODE = 0o100444;
const EINVAL = 28;
const ENOENT = 44;
const EPERM = 63;

export interface InputFsOptions {
  /** Bytes fetched from a Blob per synchronous read. */
  chunkBytes?: number;
  /** Chunks kept (shared by all inputs: a merge reads video and audio inputs in turn). */
  cachedChunks?: number;
  /** Reads part of a Blob synchronously (FileReaderSync in a worker). */
  readSync?: (blob: Blob) => ArrayBuffer;
}

interface InputNode extends FsNode {
  blob?: Blob;
}

interface Chunk {
  blob: Blob;
  start: number;
  data: Uint8Array;
}

/** FileReaderSync is a worker global the DOM typings do not declare. */
function defaultReadSync(): (blob: Blob) => ArrayBuffer {
  const Reader = (globalThis as { FileReaderSync?: new () => { readAsArrayBuffer(blob: Blob): ArrayBuffer } }).FileReaderSync;
  if (!Reader) throw new Error('FileReaderSync is not available (inputs can only be read in a worker)');
  const reader = new Reader();
  return (blob) => reader.readAsArrayBuffer(blob);
}

/**
 * Read-only filesystem for FFmpeg's inputs, mounted at /in: Blobs read on
 * demand, like Emscripten's WORKERFS, but in large chunks.
 *
 * FFmpeg reads its inputs 32 KiB at a time. WORKERFS turns every such read
 * into a synchronous Blob read (FileReaderSync), a round trip to Chrome's
 * Blob storage each; a 1.5 GB merge makes some 50 000 of them. Here a read
 * fetches `chunkBytes` (4 MiB) at once and serves the following reads from
 * it. A few chunks are kept, across inputs, because a merge alternates
 * between the video input and the audio inputs. Memory: chunkBytes ×
 * cachedChunks (16 MiB by default), whatever the input sizes.
 */
export class InputFs {
  readonly #fs: EmscriptenFs;
  readonly #chunkBytes: number;
  readonly #cachedChunks: number;
  readonly #readSyncOption: ((blob: Blob) => ArrayBuffer) | undefined;
  #readSync: ((blob: Blob) => ArrayBuffer) | undefined;
  /** Most recently used last. */
  #chunks: Chunk[] = [];
  /** Synchronous Blob reads so far (diagnostics, tests). */
  blobReads = 0;

  constructor(fs: EmscriptenFs, options: InputFsOptions = {}) {
    this.#fs = fs;
    this.#chunkBytes = options.chunkBytes ?? 4 * 1024 * 1024;
    this.#cachedChunks = Math.max(1, options.cachedChunks ?? 4);
    this.#readSyncOption = options.readSync;
  }

  /** The filesystem type, for `FS.mount(inputFs.type, { blobs: [{ name, data }] }, '/in')`. */
  get type(): { mount(mount: { opts: { blobs?: { name: string; data: Blob }[] } }): FsNode } {
    return {
      mount: (mount) => {
        // A new command: chunks of the previous command's Blobs are no use.
        this.#chunks = [];
        const root = this.#createNode(null, '/', DIR_MODE);
        for (const { name, data } of mount.opts.blobs ?? []) this.#createNode(root, name, FILE_MODE, data);
        return root;
      },
    };
  }

  #createNode(parent: InputNode | null, name: string, mode: number, blob?: Blob): InputNode {
    const node = this.#fs.createNode(parent, name, mode, 0) as InputNode;
    node.node_ops = this.#nodeOps;
    node.stream_ops = this.#streamOps;
    node.timestamp = Date.now();
    if (blob) node.blob = blob;
    else node.contents = {};
    if (parent?.contents) parent.contents[name] = node;
    return node;
  }

  #error(code: number): Error {
    return new this.#fs.ErrnoError(code);
  }

  readonly #nodeOps = {
    getattr: (node: InputNode) => {
      const size = node.blob?.size ?? 4096;
      const time = new Date(node.timestamp);
      return { dev: 1, ino: node.id, mode: node.mode, nlink: 1, uid: 0, gid: 0, rdev: 0, size, atime: time, mtime: time, ctime: time, blksize: 4096, blocks: Math.ceil(size / 4096) };
    },
    setattr: (node: InputNode, attr: { mode?: number; timestamp?: number }) => {
      if (attr.mode !== undefined) node.mode = attr.mode;
      if (attr.timestamp !== undefined) node.timestamp = attr.timestamp;
    },
    lookup: () => {
      throw this.#error(ENOENT);
    },
    mknod: () => {
      throw this.#error(EPERM);
    },
    rename: () => {
      throw this.#error(EPERM);
    },
    unlink: () => {
      throw this.#error(EPERM);
    },
    rmdir: () => {
      throw this.#error(EPERM);
    },
    readdir: (node: InputNode) => ['.', '..', ...Object.keys(node.contents ?? {})],
    symlink: () => {
      throw this.#error(EPERM);
    },
  };

  readonly #streamOps = {
    read: (stream: FsStream, buffer: Int8Array | Uint8Array, offset: number, length: number, position: number) => {
      const { blob } = stream.node as InputNode;
      if (!blob) throw this.#error(EINVAL);
      const end = Math.min(position + length, blob.size);
      const target = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, Math.max(0, end - position));
      let copied = 0;
      while (position + copied < end) {
        const at = position + copied;
        const chunk = this.#chunkAt(blob, at);
        const from = at - chunk.start;
        const count = Math.min(end - at, chunk.data.length - from);
        target.set(chunk.data.subarray(from, from + count), copied);
        copied += count;
      }
      return copied;
    },
    llseek: (stream: FsStream, offset: number, whence: number) => {
      const size = (stream.node as InputNode).blob?.size ?? 0;
      const position = (whence === 1 ? stream.position : whence === 2 ? size : 0) + offset;
      if (position < 0) throw this.#error(EINVAL);
      return position;
    },
  };

  /** The cached chunk holding `position` of `blob`, reading it if needed. */
  #chunkAt(blob: Blob, position: number): Chunk {
    const index = this.#chunks.findIndex((chunk) => chunk.blob === blob && position >= chunk.start && position < chunk.start + chunk.data.length);
    if (index >= 0) {
      const [hit] = this.#chunks.splice(index, 1);
      if (hit) {
        this.#chunks.push(hit);
        return hit;
      }
    }
    this.#readSync ??= this.#readSyncOption ?? defaultReadSync();
    const end = Math.min(position + this.#chunkBytes, blob.size);
    this.blobReads += 1;
    const chunk: Chunk = { blob, start: position, data: new Uint8Array(this.#readSync(blob.slice(position, end))) };
    this.#chunks.push(chunk);
    if (this.#chunks.length > this.#cachedChunks) this.#chunks.shift();
    return chunk;
  }
}
