import { resolveObjectURL } from 'node:buffer';
import type { FileSaver, Notifier, SaveState } from '@/core/download/download-coordinator';
import type { DownloadTask } from '@/core/models/download-task';

interface SavedEntry extends SaveState {
  url: string;
  data?: Blob;
}

/** A remote file as the fake server answers it (progressive files, 0.3.0). */
export interface RemoteFile {
  mime: string;
  size: number;
  /** Chrome's interrupt reason for a refused request (SERVER_FORBIDDEN…), reported at once. */
  error?: string;
}

/**
 * Extensions Chrome accepts for a MIME type, the first one preferred. A blob
 * without a type is sniffed; for a merged video Chrome ends up with
 * text/plain (seen in Chrome: the file was saved as .txt).
 */
const MIME_EXTENSIONS: Record<string, string[]> = {
  'video/mp4': ['mp4', 'm4v', 'mp4v'],
  'video/x-matroska': ['mkv'],
  'video/webm': ['webm'],
  'text/html': ['htm', 'html'],
  'text/plain': ['txt', 'text'],
};

/**
 * What Chrome does to the file name it is given (net::GenerateFileName →
 * EnsureSafeExtension): an extension that does not belong to the response's
 * MIME type is replaced by that type's preferred one.
 */
export function chromeFileName(fileName: string, mimeType: string): string {
  const extensions = MIME_EXTENSIONS[mimeType || 'text/plain'];
  const match = /^(.*)\.(\w+)$/.exec(fileName);
  const [stem, extension] = match ? [match[1] ?? fileName, match[2] ?? ''] : [fileName, ''];
  if (!extensions || extensions.includes(extension.toLowerCase())) return fileName;
  return `${stem}.${extensions[0] ?? extension}`;
}

/**
 * chrome.downloads for tests: "saves" a blob: URL by resolving it to its Blob
 * (Node's resolveObjectURL), like Chrome reading it from the offscreen
 * document; names the file the way Chrome does from the Blob's type, and
 * renames on collisions like `conflictAction: 'uniquify'`. Saves complete at
 * once unless `manual` is set, and `onChanged` is called the way
 * chrome.downloads.onChanged would be.
 */
export class FakeFiles implements FileSaver {
  readonly entries = new Map<number, SavedEntry>();
  readonly cancelled: number[] = [];
  /** Complete saves only when the test calls finish(). */
  manual = false;
  /** Refuse to start (e.g. an invalid file name). */
  refuse: string | undefined;
  onChanged: ((downloadId: number) => void) | undefined;
  /** http(s) URLs Chrome downloads itself (progressive files): what each answers (default: a 1000-byte MP4). Others are blob: URLs. */
  readonly remote = new Map<string, RemoteFile>();
  readonly resumed: number[] = [];
  readonly removed: number[] = [];
  #nextId = 1;

  save({ url, fileName }: { url: string; fileName: string }): Promise<number> {
    if (this.refuse !== undefined) return Promise.reject(new Error(this.refuse));
    const id = this.#nextId++;
    // Files on disk and saves in progress hold their names; a failed save does not.
    const taken = new Set([...this.entries.values()].filter((entry) => entry.state !== 'interrupted').map((entry) => entry.path));
    // Chrome decides the name once the response (the Blob) tells it the content's type.
    const remote = this.#remote(url);
    const name = chromeFileName(fileName, remote ? remote.mime : (resolveObjectURL(url)?.type ?? ''));
    let path = `/Downloads/${name}`;
    for (let n = 1; taken.has(path); n++) path = `/Downloads/${name.replace(/(\.\w+)$/, ` (${n})$1`)}`;
    const entry: SavedEntry = { state: 'in_progress', path, bytes: 0, url };
    if (remote) Object.assign(entry, { received: 0, total: remote.size, mime: remote.mime, canResume: false });
    this.entries.set(id, entry);
    if (!this.manual) this.finish(id);
    return Promise.resolve(id);
  }

  /** Chrome finished reading the blob: URL (or failed with `error`). */
  finish(id: number, error?: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const remote = this.#remote(entry.url);
    if (remote) {
      const reason = error ?? remote.error;
      if (reason !== undefined) Object.assign(entry, { state: 'interrupted', error: reason });
      else Object.assign(entry, { state: 'complete', received: remote.size, bytes: remote.size });
      queueMicrotask(() => this.onChanged?.(id));
      return;
    }
    if (error !== undefined) {
      entry.state = 'interrupted';
      entry.error = error;
    } else {
      const blob = resolveObjectURL(entry.url);
      if (blob) {
        entry.data = blob as unknown as Blob;
        entry.bytes = blob.size;
        entry.state = 'complete';
      } else {
        entry.state = 'interrupted';
        entry.error = 'NETWORK_FAILED'; // the URL was revoked: what Chrome reports
      }
    }
    queueMicrotask(() => this.onChanged?.(id));
  }

  find(id: number): Promise<SaveState | undefined> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve(undefined);
    const { url: _url, data: _data, ...state } = entry;
    return Promise.resolve({ ...state });
  }

  /** A remote download received this much so far (manual mode). */
  advance(id: number, received: number): void {
    const entry = this.entries.get(id);
    if (entry?.state === 'in_progress') entry.received = received;
  }

  /** A remote download stopped: Chrome's reason, and whether Chrome could continue it. */
  interrupt(id: number, error: string, canResume: boolean): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    Object.assign(entry, { state: 'interrupted', error, canResume });
    queueMicrotask(() => this.onChanged?.(id));
  }

  resume(id: number): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry?.canResume || entry.state !== 'interrupted') return Promise.reject(new Error('Download must be resumable'));
    this.resumed.push(id);
    const { error: _error, ...rest } = entry;
    this.entries.set(id, { ...rest, state: 'in_progress', canResume: false });
    if (!this.manual) this.finish(id);
    return Promise.resolve();
  }

  removeFile(id: number): Promise<void> {
    this.removed.push(id);
    return Promise.resolve();
  }

  /** Erased from Chrome's list (the user removed it there). */
  erase(id: number): void {
    this.entries.delete(id);
  }

  #remote(url: string): RemoteFile | undefined {
    return /^https?:/.test(url) ? (this.remote.get(url) ?? { mime: 'video/mp4', size: 1000 }) : undefined;
  }

  cancel(id: number): Promise<void> {
    this.cancelled.push(id);
    const entry = this.entries.get(id);
    if (entry?.state === 'in_progress' || entry?.state === 'interrupted') {
      entry.state = 'interrupted';
      entry.error = 'USER_CANCELED';
      entry.canResume = false;
    }
    return Promise.resolve();
  }

  /** Bytes of the file saved under `fileName` (the first one, without uniquifying). */
  async bytesOf(fileName: string): Promise<Uint8Array | undefined> {
    const entry = [...this.entries.values()].find((candidate) => candidate.path === `/Downloads/${fileName}`);
    return entry?.data ? new Uint8Array(await entry.data.arrayBuffer()) : undefined;
  }
}

export class FakeNotifier implements Notifier {
  readonly shown: { kind: 'completed' | 'failed'; taskId: string }[] = [];
  completed(task: DownloadTask): void {
    this.shown.push({ kind: 'completed', taskId: task.id });
  }
  failed(task: DownloadTask): void {
    this.shown.push({ kind: 'failed', taskId: task.id });
  }
}
