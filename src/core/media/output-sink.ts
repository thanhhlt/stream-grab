/**
 * Where FFmpeg writes its outputs: a write-mostly file that streams into Blob
 * parts instead of living in memory.
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

export interface SinkOptions {
  headBytes?: number;
  windowBytes?: number;
  flushBytes?: number;
}

const DEFAULTS = { headBytes: 1024 * 1024, windowBytes: 64 * 1024 * 1024, flushBytes: 32 * 1024 * 1024 };

export class SinkAccessError extends Error {
  constructor(position: number) {
    super(`FFmpeg went back to byte ${position} of its output, which had already been written out`);
    this.name = 'SinkAccessError';
  }
}

export class BlobSink {
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
