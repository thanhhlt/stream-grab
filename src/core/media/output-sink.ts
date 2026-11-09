/**
 * Where FFmpeg writes its outputs (SinkFs): a FileSink, a file of the origin
 * private file system written through a synchronous access handle (0.4.0;
 * see output-files.ts), or, when that is not available, a BlobSink.
 *
 * A BlobSink is a write-mostly file that streams into Blob parts instead of
 * living in memory.
 *
 * Emscripten's MEMFS keeps every file in one JavaScript array that grows by
 * copying, so a 3 GB merge would need several GB of memory at once. Muxers,
 * however, write almost sequentially: MP4 (without "faststart") and Matroska
 * write their media in order and, at the end, only patch a few header fields
 * near the start of the file (MP4: the mdat size; Matroska: SeekHead, segment
 * size, duration). A BlobSink therefore keeps:
 *
 * - the first `headBytes` (1 MiB) in memory until the end, for those patches;
 * - a moving window of the most recent bytes, at most `windowBytes`;
 * - everything older as immutable Blob parts (Chrome moves large Blob data
 *   to disk), flushed `flushBytes` at a time.
 *
 * A write or read inside the flushed part is refused (EIO): the muxer then
 * fails with an I/O error instead of producing a damaged file, and the sink
 * records why. Memory stays at about head + window whatever the output size.
 */

/** A file FFmpeg writes, as SinkFs sees it. */
export interface OutputSink {
  readonly size: number;
  /** Set once an access was refused or failed: FFmpeg got an I/O error, and the file is not usable. */
  readonly failure: SinkError | undefined;
  write(data: Uint8Array, position: number): void;
  /** Copies bytes at `position` into `target`; returns how many (fewer at the end of the file). */
  read(target: Uint8Array, position: number): number;
  truncate(size: number): void;
}

export interface SinkOptions {
  headBytes?: number;
  windowBytes?: number;
  flushBytes?: number;
}

const DEFAULTS = { headBytes: 1024 * 1024, windowBytes: 64 * 1024 * 1024, flushBytes: 32 * 1024 * 1024 };

/** An output access that could not be served; SinkFs turns it into EIO for FFmpeg. */
export abstract class SinkError extends Error {}

export class SinkAccessError extends SinkError {
  constructor(position: number) {
    super(`FFmpeg went back to byte ${position} of its output, which had already been written out`);
    this.name = 'SinkAccessError';
  }
}

/** Writing an output file failed; `diskFull` when the disk (or the browser's quota) has no room left. */
export class SinkStorageError extends SinkError {
  readonly diskFull: boolean;

  constructor(cause: unknown) {
    const diskFull = cause instanceof Error && cause.name === 'QuotaExceededError';
    super(
      diskFull
        ? 'There is not enough disk space to write the merged file'
        : `Writing the merged file failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'SinkStorageError';
    this.diskFull = diskFull;
  }
}

export class BlobSink implements OutputSink {
  readonly #head: number;
  readonly #window: number;
  readonly #flush: number;
  /** Bytes [0, min(size, head)), zero-filled where nothing was written. */
  #headData = new Uint8Array(0);
  /** Flushed data, covering [head, tailStart). */
  #parts: Blob[] = [];
  /** First position held by the tail buffer (≥ head). */
  #tailStart: number;
  /** Bytes [tailStart, size), possibly with spare capacity after them. */
  #tail = new Uint8Array(0);
  #size = 0;
  /** Set when the muxer touched flushed data. */
  failure: SinkAccessError | undefined;

  constructor(options: SinkOptions = {}) {
    this.#head = options.headBytes ?? DEFAULTS.headBytes;
    this.#window = options.windowBytes ?? DEFAULTS.windowBytes;
    this.#flush = Math.min(options.flushBytes ?? DEFAULTS.flushBytes, this.#window);
    this.#tailStart = this.#head;
  }

  get size(): number {
    return this.#size;
  }

  /** Bytes held in memory (head and window buffers). */
  get bufferedBytes(): number {
    return this.#headData.length + this.#tail.length;
  }

  write(data: Uint8Array, position: number): void {
    const end = position + data.length;
    if (end > this.#size) this.#extend(end);
    if (position < this.#head) {
      const until = Math.min(end, this.#head);
      this.#headData.set(data.subarray(0, until - position), position);
    }
    const flushedFrom = Math.max(position, this.#head);
    if (flushedFrom < Math.min(end, this.#tailStart)) throw this.#refuse(flushedFrom);
    if (end > this.#tailStart) {
      const from = Math.max(position, this.#tailStart);
      this.#tail.set(data.subarray(from - position), from - this.#tailStart);
    }
    this.#flushOld();
  }

  /** Copies bytes at `position` into `target`; returns how many (fewer at the end of the file). */
  read(target: Uint8Array, position: number): number {
    const end = Math.min(position + target.length, this.#size);
    let copied = 0;
    for (let at = position; at < end; ) {
      if (at < this.#head) {
        const until = Math.min(end, this.#head);
        target.set(this.#headData.subarray(at, until), copied);
        copied += until - at;
        at = until;
      } else if (at < this.#tailStart) {
        throw this.#refuse(at);
      } else {
        target.set(this.#tail.subarray(at - this.#tailStart, end - this.#tailStart), copied);
        copied += end - at;
        at = end;
      }
    }
    return copied;
  }

  truncate(size: number): void {
    if (size === 0) {
      this.#headData = new Uint8Array(0);
      this.#parts = [];
      this.#tailStart = this.#head;
      this.#tail = new Uint8Array(0);
      this.#size = 0;
    } else if (size > this.#size) {
      this.#extend(size);
    } else if (size < this.#size) {
      if (size < this.#tailStart && this.#parts.length > 0) throw this.#refuse(size);
      this.#headData.fill(0, Math.min(size, this.#headData.length));
      this.#tail.fill(0, Math.max(0, size - this.#tailStart));
      this.#size = size;
    }
  }

  /** The whole file. */
  toBlob(): Blob {
    const parts: BlobPart[] = [this.#headData.slice(0, Math.min(this.#size, this.#head))];
    if (this.#size > this.#head) {
      parts.push(...this.#parts);
      if (this.#size > this.#tailStart) parts.push(this.#tail.slice(0, this.#size - this.#tailStart));
    }
    return new Blob(parts);
  }

  /** Grows the file to `size` with zeros. */
  #extend(size: number): void {
    const head = Math.min(size, this.#head);
    if (this.#headData.length < head) {
      const grown = new Uint8Array(Math.min(this.#head, Math.max(head, this.#headData.length * 2, 4096)));
      grown.set(this.#headData);
      this.#headData = grown;
    }
    const tail = size - this.#tailStart;
    if (tail > this.#tail.length) {
      const grown = new Uint8Array(Math.max(tail, Math.min(Math.max(this.#tail.length * 2, 64 * 1024), this.#window + this.#flush)));
      grown.set(this.#tail);
      this.#tail = grown;
    }
    this.#size = size;
  }

  /** Moves the oldest data of the window into Blob parts while the window is too large. */
  #flushOld(): void {
    const held = this.#size - this.#tailStart;
    if (held <= this.#window) return;
    let offset = 0;
    while (held - offset > this.#window) {
      this.#parts.push(new Blob([this.#tail.slice(offset, offset + this.#flush)]));
      offset += this.#flush;
    }
    this.#tail = this.#tail.slice(offset, held);
    this.#tailStart += offset;
  }

  #refuse(position: number): SinkAccessError {
    this.failure ??= new SinkAccessError(position);
    return this.failure;
  }
}

/** The parts of FileSystemSyncAccessHandle a FileSink uses (all synchronous). */
export interface SyncFileHandle {
  read(buffer: Uint8Array, options: { at: number }): number;
  write(buffer: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

/**
 * An output written straight to a file on disk through a synchronous access
 * handle: FFmpeg may write and read anywhere in it (MP4 "faststart" included),
 * and nothing of it stays in memory. A failed access (the disk is full) is
 * recorded and refused like BlobSink's.
 */
export class FileSink implements OutputSink {
  readonly #handle: SyncFileHandle;
  #size: number;
  #closed = false;
  failure: SinkStorageError | undefined;

  constructor(handle: SyncFileHandle) {
    this.#handle = handle;
    this.#size = handle.getSize();
  }

  get size(): number {
    return this.#size;
  }

  write(data: Uint8Array, position: number): void {
    this.#io(() => {
      const written = this.#handle.write(data, { at: position });
      if (written !== data.length) throw new Error(`only ${written} of ${data.length} bytes were written`);
    });
    this.#size = Math.max(this.#size, position + data.length);
  }

  read(target: Uint8Array, position: number): number {
    if (position >= this.#size) return 0;
    const wanted = Math.min(target.length, this.#size - position);
    return this.#io(() => this.#handle.read(target.subarray(0, wanted), { at: position }));
  }

  truncate(size: number): void {
    this.#io(() => {
      this.#handle.truncate(size);
    });
    this.#size = size;
  }

  /** Writes everything out and releases the file, once; a failure to write out is recorded. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#io(() => {
        this.#handle.flush();
      });
    } catch {
      // Recorded in `failure`.
    }
    try {
      this.#handle.close();
    } catch {
      // Already released (its worker is going away): nothing is left to write.
    }
  }

  #io<T>(operation: () => T): T {
    if (this.failure) throw this.failure;
    try {
      return operation();
    } catch (error) {
      this.failure = new SinkStorageError(error);
      throw this.failure;
    }
  }
}
