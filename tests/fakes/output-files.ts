import type { OutputFile, OutputFileStore, RemoveOutcome } from '@/core/media/output-files';
import type { SyncFileHandle } from '@/core/media/output-sink';

const domError = (name: string, message = name): Error => new DOMException(message, name);

/** What Chrome types an OPFS file as, from its name (checked in 0.4.0 Phase 1). */
const typeOf = (name: string): string => (name.endsWith('.mp4') ? 'video/mp4' : name.endsWith('.mkv') ? 'video/matroska' : '');

/** A growable in-memory file behind a FileSystemSyncAccessHandle-like handle. */
export class MemorySyncHandle implements SyncFileHandle {
  bytes = new Uint8Array(0);
  size = 0;
  closed = false;
  flushes = 0;
  /** Writes ending past this many bytes fail like a full disk. */
  quota = Number.POSITIVE_INFINITY;

  read(buffer: Uint8Array, options: { at: number }): number {
    this.#open();
    const end = Math.min(this.size, options.at + buffer.length);
    if (end <= options.at) return 0;
    buffer.set(this.bytes.subarray(options.at, end));
    return end - options.at;
  }

  write(buffer: Uint8Array, options: { at: number }): number {
    this.#open();
    const end = options.at + buffer.length;
    if (end > this.quota) throw domError('QuotaExceededError', 'The quota has been exceeded.');
    this.#grow(end);
    this.bytes.set(buffer, options.at);
    this.size = Math.max(this.size, end);
    return buffer.length;
  }

  truncate(size: number): void {
    this.#open();
    this.#grow(size);
    this.bytes.fill(0, size);
    this.size = size;
  }

  getSize(): number {
    this.#open();
    return this.size;
  }

  flush(): void {
    this.#open();
    this.flushes += 1;
  }

  close(): void {
    this.closed = true;
  }

  #open(): void {
    if (this.closed) throw domError('InvalidStateError', 'The access handle was closed.');
  }

  #grow(size: number): void {
    if (size <= this.bytes.length) return;
    const grown = new Uint8Array(Math.max(size, this.bytes.length * 2, 4096));
    grown.set(this.bytes.subarray(0, this.size));
    this.bytes = grown;
  }
}

/**
 * OutputFileStore in memory with OPFS's rules: one open handle per file, and
 * an open file cannot be removed (NoModificationAllowedError). A file read
 * back is a Blob typed from its extension, as Chrome types OPFS files.
 */
export class MemoryOutputFiles implements OutputFileStore {
  readonly files = new Map<string, MemorySyncHandle>();
  readonly opened: string[] = [];
  readonly removed: string[] = [];
  /** Makes open() fail (no OPFS here). */
  failOpen: Error | undefined;
  /** The quota of files opened from now on. */
  quota = Number.POSITIVE_INFINITY;

  open(name: string): Promise<OutputFile> {
    if (this.failOpen) return Promise.reject(this.failOpen);
    const existing = this.files.get(name);
    if (existing && !existing.closed) return Promise.reject(domError('NoModificationAllowedError'));
    const handle = new MemorySyncHandle();
    handle.quota = this.quota;
    this.files.set(name, handle);
    this.opened.push(name);
    return Promise.resolve({
      handle,
      read: () => Promise.resolve(new Blob([handle.bytes.slice(0, handle.size)], { type: typeOf(name) })),
    });
  }

  /** Every remove() call, in order, whatever it found. */
  readonly removeCalls: string[] = [];

  remove(name: string): Promise<RemoveOutcome> {
    this.removeCalls.push(name);
    const file = this.files.get(name);
    if (!file) return Promise.resolve('missing');
    if (!file.closed) return Promise.resolve('locked');
    this.files.delete(name);
    this.removed.push(name);
    return Promise.resolve('removed');
  }

  names(): Promise<string[]> {
    return Promise.resolve([...this.files.keys()]);
  }

  /** A file left behind, as a crashed merge would leave it. */
  leave(name: string, open = false): MemorySyncHandle {
    const handle = new MemorySyncHandle();
    handle.closed = !open;
    this.files.set(name, handle);
    return handle;
  }
}
