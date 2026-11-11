import type { OutputFileStore, RemoveOutcome } from '@/core/media/output-files';
import type { SyncFileHandle } from '@/core/media/output-sink';
import type { ProgressiveContainer } from '@/core/models/detected-stream';

/**
 * Progressive files the engine fetches (0.6.0), kept on disk while they come
 * in so a later run continues them with a Range request instead of starting
 * over: in-run retries, a refreshed link, the user's Retry, and an offscreen
 * document, service worker or browser that was closed or crashed.
 *
 * Each task has two files in the origin private file system's `files`
 * directory: `<taskId>.<mp4|webm>`, the bytes received so far (its size is
 * where the next request starts), and `<taskId>.json`, what identifies the
 * response they came from (its validator and total size). The data file is
 * written through a synchronous access handle in a dedicated worker: checked
 * in Chrome (0.6.0 Phase 1), every byte written that way survives the
 * offscreen document closing and Chrome being killed, while a main-thread
 * writable stream keeps nothing until it is closed.
 *
 * The offscreen document deletes both files once Chrome has saved the file or
 * the task was cancelled; the service worker deletes those no task needs.
 */

/** OPFS directory of progressive files in progress. */
export const PARTIAL_DIRECTORY = 'files';

const TASK_PART = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;

/** The task's data file; undefined when the task ID cannot be part of a file name (those files stay in memory). */
export function partialFileName(taskId: string, container: ProgressiveContainer): string | undefined {
  return TASK_PART.test(taskId) ? `${taskId}.${container}` : undefined;
}

/** The task's record of what its data file holds. */
export function partialMetaName(taskId: string): string | undefined {
  return TASK_PART.test(taskId) ? `${taskId}.json` : undefined;
}

/** The task a file of the directory belongs to; undefined for a name StreamGrab does not write. */
export function taskIdOfPartialFile(name: string): string | undefined {
  const parts = name.split('.');
  const [taskId] = parts;
  return parts.length === 2 && taskId !== undefined && TASK_PART.test(taskId) ? taskId : undefined;
}

/** A file open for appending. */
export interface PartialFile {
  /** Bytes the file holds. */
  readonly size: number;
  /** Writes at the end. The buffer may be transferred: do not use `data` afterwards. */
  append(data: Uint8Array<ArrayBuffer>): Promise<void>;
  truncate(size: number): Promise<void>;
  /** Writes buffered data out to disk. */
  flush(): Promise<void>;
  /** Flushes and releases the file (once); it stays on disk. */
  close(): Promise<void>;
}

export interface PartialFileStore {
  /** Opens the file for appending, keeping what it holds (created empty when missing). */
  open(name: string): Promise<PartialFile>;
  /** Replaces a small file's contents in one go, flushed. */
  put(name: string, data: Uint8Array<ArrayBuffer>): Promise<void>;
  /** A closed file's contents; undefined when there is no such file. */
  read(name: string): Promise<Blob | undefined>;
  remove(name: string, options?: { waitLockedMs?: number }): Promise<RemoveOutcome>;
}

class SyncPartialFile implements PartialFile {
  readonly #handle: SyncFileHandle;
  #size: number;
  #closed = false;

  constructor(handle: SyncFileHandle) {
    this.#handle = handle;
    this.#size = handle.getSize();
  }

  get size(): number {
    return this.#size;
  }

  append(data: Uint8Array<ArrayBuffer>): Promise<void> {
    return attempt(() => {
      const length = data.byteLength;
      const written = this.#handle.write(data, { at: this.#size });
      if (written !== length) throw new Error(`only ${written} of ${length} bytes were written`);
      this.#size += length;
    });
  }

  truncate(size: number): Promise<void> {
    return attempt(() => {
      this.#handle.truncate(size);
      this.#size = size;
    });
  }

  flush(): Promise<void> {
    return attempt(() => {
      this.#handle.flush();
    });
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    return attempt(() => {
      try {
        this.#handle.flush();
      } finally {
        this.#handle.close();
      }
    });
  }
}

/** Runs a synchronous file operation as a promise (its exception becomes the rejection). */
function attempt(operation: () => void): Promise<void> {
  try {
    operation();
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * PartialFileStore on synchronous access handles: what the file worker runs
 * (on OpfsOutputFiles), and what tests run directly (on MemoryOutputFiles).
 */
export class SyncPartialFiles implements PartialFileStore {
  readonly #files: OutputFileStore;

  constructor(files: OutputFileStore) {
    this.#files = files;
  }

  async open(name: string): Promise<PartialFile> {
    const { handle } = await this.#files.open(name, { keepData: true });
    return new SyncPartialFile(handle);
  }

  async put(name: string, data: Uint8Array<ArrayBuffer>): Promise<void> {
    const { handle } = await this.#files.open(name);
    try {
      const written = handle.write(data, { at: 0 });
      if (written !== data.byteLength) throw new Error(`only ${written} of ${data.byteLength} bytes were written`);
      handle.flush();
    } finally {
      handle.close();
    }
  }

  read(name: string): Promise<Blob | undefined> {
    return this.#files.read(name);
  }

  remove(name: string, options?: { waitLockedMs?: number }): Promise<RemoveOutcome> {
    return this.#files.remove(name, options);
  }
}

// ------------------------------------------------------------------ worker protocol

export type PartialFileRequest =
  | { id: number; op: 'open'; name: string }
  | { id: number; op: 'append'; name: string; data: Uint8Array<ArrayBuffer> }
  | { id: number; op: 'truncate'; name: string; size: number }
  | { id: number; op: 'flush'; name: string }
  | { id: number; op: 'close'; name: string }
  | { id: number; op: 'put'; name: string; data: Uint8Array<ArrayBuffer> };

export type PartialFileResponse = { id: number; size?: number } | { id: number; error: { name: string; message: string } };

const OPS = new Set(['open', 'append', 'truncate', 'flush', 'close', 'put']);

function parseRequest(raw: unknown): PartialFileRequest | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'number' || typeof value.op !== 'string' || !OPS.has(value.op) || typeof value.name !== 'string') return undefined;
  if ((value.op === 'append' || value.op === 'put') && !(value.data instanceof Uint8Array)) return undefined;
  if (value.op === 'truncate' && (typeof value.size !== 'number' || value.size < 0)) return undefined;
  return value as unknown as PartialFileRequest;
}

/**
 * The file worker's logic: holds the open files by name and runs the
 * offscreen document's requests one after another, in the order sent.
 */
export class PartialFileHost {
  readonly #store: PartialFileStore;
  readonly #open = new Map<string, PartialFile>();
  #chain: Promise<unknown> = Promise.resolve();

  constructor(store: PartialFileStore) {
    this.#store = store;
  }

  handle(raw: unknown): Promise<PartialFileResponse> {
    const result = this.#chain.then(() => this.#handle(raw));
    this.#chain = result;
    return result;
  }

  async #handle(raw: unknown): Promise<PartialFileResponse> {
    const request = parseRequest(raw);
    const id = typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'number' ? raw.id : -1;
    if (!request) return { id, error: { name: 'TypeError', message: 'Invalid file request' } };
    try {
      const { name } = request;
      if (request.op === 'open') {
        // One handle per file: a second run of the same task must wait for the first to close it.
        if (this.#open.has(name)) throw new DOMException(`${name} is already open`, 'NoModificationAllowedError');
        const file = await this.#store.open(name);
        this.#open.set(name, file);
        return { id, size: file.size };
      }
      if (request.op === 'put') {
        await this.#store.put(name, request.data);
        return { id };
      }
      const file = this.#open.get(name);
      if (!file) throw new DOMException(`${name} is not open`, 'InvalidStateError');
      switch (request.op) {
        case 'append':
          await file.append(request.data);
          break;
        case 'truncate':
          await file.truncate(request.size);
          break;
        case 'flush':
          await file.flush();
          break;
        case 'close':
          this.#open.delete(name);
          await file.close();
          break;
      }
      return { id, size: file.size };
    } catch (error) {
      return { id, error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) } };
    }
  }
}

/** The parts of Worker used here. */
export interface WorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  addEventListener(type: 'error', listener: (event: Event) => void): void;
  terminate(): void;
}

/**
 * PartialFileStore of the offscreen document: opening and writing go to the
 * file worker (only a dedicated worker has synchronous access handles);
 * reading and removing closed files is done here. The worker starts with
 * the first file opened; when it fails, pending requests fail and the next
 * one starts a new worker.
 */
export class WorkerPartialFiles implements PartialFileStore {
  readonly #createWorker: () => WorkerLike;
  readonly #files: Pick<OutputFileStore, 'read' | 'remove'>;
  #worker: WorkerLike | undefined;
  #nextId = 1;
  readonly #pending = new Map<number, { resolve: (size: number | undefined) => void; reject: (error: Error) => void }>();

  constructor(createWorker: () => WorkerLike, files: Pick<OutputFileStore, 'read' | 'remove'>) {
    this.#createWorker = createWorker;
    this.#files = files;
  }

  async open(name: string): Promise<PartialFile> {
    let size = (await this.#request({ op: 'open', name })) ?? 0;
    let closed = false;
    return {
      get size() {
        return size;
      },
      append: async (data) => {
        size = (await this.#request({ op: 'append', name, data }, transferable(data))) ?? size;
      },
      truncate: async (to) => {
        size = (await this.#request({ op: 'truncate', name, size: to })) ?? to;
      },
      flush: async () => {
        await this.#request({ op: 'flush', name });
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await this.#request({ op: 'close', name });
      },
    };
  }

  async put(name: string, data: Uint8Array<ArrayBuffer>): Promise<void> {
    await this.#request({ op: 'put', name, data }, transferable(data));
  }

  read(name: string): Promise<Blob | undefined> {
    return this.#files.read(name);
  }

  remove(name: string, options?: { waitLockedMs?: number }): Promise<RemoveOutcome> {
    return this.#files.remove(name, options);
  }

  #request(request: DistributiveOmit<PartialFileRequest, 'id'>, transfer: Transferable[] = []): Promise<number | undefined> {
    const worker = this.#ensure();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ ...request, id }, transfer);
      } catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #ensure(): WorkerLike {
    if (this.#worker) return this.#worker;
    const worker = this.#createWorker();
    worker.addEventListener('message', (event: MessageEvent) => {
      const response = event.data as PartialFileResponse;
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#pending.delete(response.id);
      if ('error' in response) pending.reject(new DOMException(response.error.message, response.error.name));
      else pending.resolve(response.size);
    });
    worker.addEventListener('error', () => {
      if (this.#worker !== worker) return;
      this.#worker = undefined;
      worker.terminate();
      const failed = [...this.#pending.values()];
      this.#pending.clear();
      for (const pending of failed) pending.reject(new Error('The file worker stopped'));
    });
    this.#worker = worker;
    return worker;
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The buffer to transfer: only when the view covers all of it (otherwise it is copied). */
function transferable(data: Uint8Array<ArrayBuffer>): Transferable[] {
  return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? [data.buffer] : [];
}
