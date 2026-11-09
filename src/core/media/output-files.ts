import type { OutputContainer } from '@/core/models/media-info';
import { containerExtension } from './containers';
import type { SyncFileHandle } from './output-sink';

/**
 * Merged files on disk, in the extension's origin private file system (OPFS),
 * instead of Blob parts Chrome holds in its browser process (0.4.0).
 *
 * The media worker opens a file with a synchronous access handle before
 * FFmpeg runs (FFmpeg's file system calls are synchronous; opening is not)
 * and hands it back as a File once the handle is closed. The offscreen
 * document deletes it when Chrome has saved its copy, or when the merge failed
 * or was cancelled; the service worker deletes whatever no running merge
 * needs (a merge cut short by a crash or a closed browser).
 *
 * Behaviour checked in Chrome (0.4.0 Phase 1): only a dedicated worker has
 * synchronous handles; a file has one at a time, and while it is open the file
 * cannot be removed (NoModificationAllowedError); a File read from it stays
 * valid until the file is written again or removed, but a download that has
 * started finishes even after the file is removed; File.type comes from the
 * name's extension.
 */

/** OPFS directory of merged files. */
export const MERGE_DIRECTORY = 'merges';

export interface OutputFile {
  /** Open for writing, empty. */
  handle: SyncFileHandle;
  /** The file as written; read it once the handle is closed. */
  read(): Promise<Blob>;
}

/** What removing a file found. */
export type RemoveOutcome = 'removed' | 'missing' | 'locked';

export interface OutputFileStore {
  /** Creates the file (or empties it) and opens it for synchronous writing (dedicated workers only). */
  open(name: string): Promise<OutputFile>;
  /**
   * Deletes the file. A file still open (a worker writing it, or one that was
   * just terminated and has not released it yet) is retried for `waitLockedMs`,
   * then reported as locked.
   */
  remove(name: string, options?: { waitLockedMs?: number }): Promise<RemoveOutcome>;
  /** Names of the files in the directory. */
  names(): Promise<string[]>;
}

const TASK_PART = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;

/**
 * The file a merge of this task writes: `<taskId>.<attempt>.<extension>`.
 * Every attempt gets a name of its own, so a file Chrome may still be reading
 * is never written again. Undefined when the task ID cannot be part of a file
 * name (task IDs are UUIDs): that merge streams into Blob parts.
 */
export function mergeFileName(taskId: string, container: OutputContainer, attempt: string): string | undefined {
  if (!TASK_PART.test(taskId) || !/^[a-z0-9]{1,13}$/.test(attempt)) return undefined;
  return `${taskId}.${attempt}${containerExtension(container)}`;
}

/** The task a merged file belongs to; undefined for a name StreamGrab does not write. */
export function taskIdOfMergeFile(name: string): string | undefined {
  const parts = name.split('.');
  const [taskId] = parts;
  return parts.length === 3 && taskId !== undefined && TASK_PART.test(taskId) ? taskId : undefined;
}

/** The parts of FileSystemFileHandle used here (the DOM typings lack createSyncAccessHandle, a worker-only method). */
interface FileHandleLike {
  getFile(): Promise<File>;
  createSyncAccessHandle(): Promise<SyncFileHandle>;
}

/** The parts of FileSystemDirectoryHandle used here. */
export interface DirectoryLike {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<unknown>;
  removeEntry(name: string): Promise<void>;
  entries(): AsyncIterable<[string, { kind: string }]>;
}

const isNamed = (error: unknown, name: string): boolean => error instanceof Error && error.name === name;

const LOCK_RETRY_MS = 100;

/** OutputFileStore on the origin private file system (navigator.storage.getDirectory()). */
export class OpfsOutputFiles implements OutputFileStore {
  readonly #root: () => Promise<DirectoryLike>;

  constructor(root?: () => Promise<DirectoryLike>) {
    this.#root = root ?? (() => navigator.storage.getDirectory());
  }

  /** The directory of merged files; undefined when it does not exist and `create` is false. */
  async #directory(create: boolean): Promise<DirectoryLike | undefined> {
    try {
      return await (await this.#root()).getDirectoryHandle(MERGE_DIRECTORY, { create });
    } catch (error) {
      if (!create && isNamed(error, 'NotFoundError')) return undefined;
      throw error;
    }
  }

  async open(name: string): Promise<OutputFile> {
    const directory = await this.#directory(true);
    if (!directory) throw new Error('The merge directory could not be created');
    const file = (await directory.getFileHandle(name, { create: true })) as FileHandleLike;
    if (typeof file.createSyncAccessHandle !== 'function') throw new Error('Synchronous file access is not available here');
    const handle = await file.createSyncAccessHandle();
    try {
      handle.truncate(0);
    } catch (error) {
      handle.close();
      throw error;
    }
    return { handle, read: () => file.getFile() };
  }

  async remove(name: string, options: { waitLockedMs?: number } = {}): Promise<RemoveOutcome> {
    const directory = await this.#directory(false);
    if (!directory) return 'missing';
    const deadline = Date.now() + (options.waitLockedMs ?? 0);
    for (;;) {
      try {
        await directory.removeEntry(name);
        return 'removed';
      } catch (error) {
        if (isNamed(error, 'NotFoundError')) return 'missing';
        if (!isNamed(error, 'NoModificationAllowedError')) throw error;
        if (Date.now() >= deadline) return 'locked';
        await new Promise((done) => setTimeout(done, LOCK_RETRY_MS));
      }
    }
  }

  async names(): Promise<string[]> {
    const directory = await this.#directory(false);
    if (!directory) return [];
    const names: string[] = [];
    for await (const [name, entry] of directory.entries()) {
      if (entry.kind === 'file') names.push(name);
    }
    return names;
  }
}
