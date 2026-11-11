import type { ProgressiveContainer } from '@/core/models/detected-stream';
import { partialFileName, partialMetaName, type PartialFile, type PartialFileStore } from './partial-files';

/**
 * Where a progressive file the engine fetches is written while it comes in
 * (0.6.0): a file on disk that a later run continues (DiskTarget), or, when
 * the origin private file system cannot be used, Blob parts held for the run
 * only (MemoryTarget, as before 0.6.0).
 *
 * Resuming needs a validator (user decision, 0.6.0): the next request asks
 * for the rest with `Range: bytes=<size>-` and `If-Range: <validator>`, so a
 * server whose file changed sends the whole new file (200) instead of the
 * rest of another one. A strong ETag is preferred, else Last-Modified; a
 * response with neither, a weak ETag only, or a content encoding (ranges
 * would count encoded bytes) is not resumed: the next request starts over,
 * as Chrome does.
 */

/** What identifies the response a file's bytes came from. */
export interface FileRecord {
  etag?: string;
  lastModified?: string;
  /** Size of the whole file, when the server announced it. */
  total?: number;
}

export interface FileTarget {
  /** Bytes held. */
  readonly size: number;
  /** Where they came from; undefined when unknown (nothing can be resumed). */
  readonly record: FileRecord | undefined;
  /** A response from the first byte: drops what is held and records where the new bytes come from. */
  restart(record: FileRecord): Promise<void>;
  /** The buffer may be transferred: do not use `data` afterwards. */
  append(data: Uint8Array<ArrayBuffer>): Promise<void>;
  /** Everything received, typed; the file is released (its data stays until discard). */
  complete(type: string): Promise<Blob>;
  /** Releases the file and keeps it, for the next run. */
  release(): Promise<void>;
  /** Releases the file and deletes it. */
  discard(): Promise<void>;
}

/** The If-Range value that continues these bytes; undefined when they cannot be continued. */
export function ifRangeValue(record: FileRecord | undefined): string | undefined {
  return record?.etag ?? record?.lastModified;
}

/** The byte the next request starts from: what is held, when it can be continued; else 0. */
export function resumePoint(target: Pick<FileTarget, 'size' | 'record'>): number {
  const { size, record } = target;
  if (size === 0 || ifRangeValue(record) === undefined) return 0;
  if (record?.total !== undefined && size > record.total) return 0;
  return size;
}

/** Validator and total size of a response that starts the file (200), or continues it (206). */
export function responseRecord(response: Pick<Response, 'status' | 'headers'>): FileRecord {
  const headers = response.headers;
  const record: FileRecord = {};
  const total =
    response.status === 206 ? parseContentRange(headers.get('content-range'))?.total : positive(headers.get('content-length'));
  if (total !== undefined) record.total = total;
  const encoding = headers.get('content-encoding')?.trim().toLowerCase();
  if ((encoding && encoding !== 'identity') || headers.get('accept-ranges')?.trim().toLowerCase() === 'none') return record;
  const etag = headers.get('etag')?.trim();
  if (etag && /^"[^"]*"$/.test(etag)) record.etag = etag; // strong only: a weak one (W/"…") may not be used with If-Range
  else {
    const lastModified = headers.get('last-modified')?.trim();
    if (lastModified && !Number.isNaN(Date.parse(lastModified))) record.lastModified = lastModified;
  }
  return record;
}

/** `bytes <start>-<end>/<total|*>`; undefined when malformed. */
export function parseContentRange(value: string | null): { start: number; end: number; total?: number } | undefined {
  const match = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i.exec(value ?? '');
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (end < start) return undefined;
  return match[3] === '*' ? { start, end } : { start, end, total: Number(match[3]) };
}

/** The total of a 416 answer (Content-Range `bytes` + ` *` + `/<total>`). */
export function unsatisfiedTotal(value: string | null): number | undefined {
  const match = /^\s*bytes\s+\*\/(\d+)\s*$/i.exec(value ?? '');
  return match ? Number(match[1]) : undefined;
}

function positive(value: string | null): number | undefined {
  if (value === null || !/^\s*\d+\s*$/.test(value)) return undefined;
  const number = Number(value);
  return number > 0 ? number : undefined;
}

function parseRecord(text: string): FileRecord | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null) return undefined;
    const { v, etag, lastModified, total } = value as Record<string, unknown>;
    if (v !== 1) return undefined;
    const record: FileRecord = {};
    if (typeof etag === 'string') record.etag = etag;
    if (typeof lastModified === 'string') record.lastModified = lastModified;
    if (typeof total === 'number' && Number.isSafeInteger(total) && total > 0) record.total = total;
    return record;
  } catch {
    return undefined;
  }
}

const encoder = new TextEncoder();

/** Buffered bytes are written out to disk this often (a crash keeps them anyway; a power cut may not). */
export const FLUSH_BYTES = 64 * 1024 * 1024;

/** How long deleting waits for a file the worker has not released yet. */
const REMOVE_WAIT_MS = 2000;

/** The task's file on disk, continued by the next run. */
export class DiskTarget implements FileTarget {
  readonly #store: PartialFileStore;
  readonly #dataName: string;
  readonly #metaName: string;
  readonly #file: PartialFile;
  #record: FileRecord | undefined;
  #unflushed = 0;
  #released = false;

  private constructor(store: PartialFileStore, dataName: string, metaName: string, file: PartialFile, record: FileRecord | undefined) {
    this.#store = store;
    this.#dataName = dataName;
    this.#metaName = metaName;
    this.#file = file;
    this.#record = record;
  }

  /** Opens the task's file with what earlier runs left; undefined when the task's ID cannot name a file. */
  static async open(store: PartialFileStore, taskId: string, container: ProgressiveContainer): Promise<DiskTarget | undefined> {
    const dataName = partialFileName(taskId, container);
    const metaName = partialMetaName(taskId);
    if (dataName === undefined || metaName === undefined) return undefined;
    const meta = await store.read(metaName).catch(() => undefined);
    const record = meta ? parseRecord(await meta.text()) : undefined;
    const file = await store.open(dataName);
    return new DiskTarget(store, dataName, metaName, file, record);
  }

  get size(): number {
    return this.#file.size;
  }

  get record(): FileRecord | undefined {
    return this.#record;
  }

  async restart(record: FileRecord): Promise<void> {
    // Data first, record second: a crash in between leaves an empty file, which nothing continues.
    await this.#file.truncate(0);
    this.#unflushed = 0;
    this.#record = record;
    try {
      await this.#store.put(this.#metaName, encoder.encode(JSON.stringify({ v: 1, ...record })));
    } catch {
      // Without its record the file cannot be continued by a later run (this run still can).
      await this.#store.remove(this.#metaName).catch(() => undefined);
    }
  }

  async append(data: Uint8Array<ArrayBuffer>): Promise<void> {
    const length = data.byteLength;
    await this.#file.append(data);
    this.#unflushed += length;
    if (this.#unflushed >= FLUSH_BYTES) {
      this.#unflushed = 0;
      await this.#file.flush();
    }
  }

  async complete(type: string): Promise<Blob> {
    await this.release();
    const file = await this.#store.read(this.#dataName);
    if (!file) throw new Error('The downloaded file is gone');
    return file.slice(0, file.size, type);
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    await this.#file.close();
  }

  async discard(): Promise<void> {
    await this.release().catch(() => undefined);
    await this.#store.remove(this.#dataName, { waitLockedMs: REMOVE_WAIT_MS }).catch(() => undefined);
    await this.#store.remove(this.#metaName, { waitLockedMs: REMOVE_WAIT_MS }).catch(() => undefined);
  }
}

/** Blob parts for this run only: retries within the run continue them, nothing survives it. */
export class MemoryTarget implements FileTarget {
  #parts: Blob[] = [];
  #size = 0;
  #record: FileRecord | undefined;

  get size(): number {
    return this.#size;
  }

  get record(): FileRecord | undefined {
    return this.#record;
  }

  restart(record: FileRecord): Promise<void> {
    this.#parts = [];
    this.#size = 0;
    this.#record = record;
    return Promise.resolve();
  }

  append(data: Uint8Array<ArrayBuffer>): Promise<void> {
    this.#parts.push(new Blob([data]));
    this.#size += data.byteLength;
    return Promise.resolve();
  }

  complete(type: string): Promise<Blob> {
    const blob = new Blob(this.#parts, { type });
    this.#parts = [];
    return Promise.resolve(blob);
  }

  release(): Promise<void> {
    return Promise.resolve();
  }

  discard(): Promise<void> {
    this.#parts = [];
    this.#size = 0;
    return Promise.resolve();
  }
}
