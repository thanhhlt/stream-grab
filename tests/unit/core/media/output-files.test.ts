import { describe, expect, it } from 'vitest';
import { isValidFileName } from '@/core/media/ffmpeg-job';
import { MERGE_DIRECTORY, mergeFileName, OpfsOutputFiles, taskIdOfMergeFile, type DirectoryLike } from '@/core/media/output-files';
import { MemorySyncHandle } from '@tests/fakes/output-files';

const domError = (name: string): Error => new DOMException(name, name);

/** A directory of the origin private file system, with its rules: an open file cannot be removed. */
class FakeDirectory implements DirectoryLike {
  readonly directories = new Map<string, FakeDirectory>();
  readonly files = new Map<string, MemorySyncHandle>();
  /** Calls of removeEntry, whatever they did. */
  removeAttempts = 0;
  /** Files that report themselves closed after this many removal attempts (a terminated worker letting go). */
  releaseAfter = new Map<string, number>();

  getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<DirectoryLike> {
    let directory = this.directories.get(name);
    if (!directory) {
      if (!options.create) return Promise.reject(domError('NotFoundError'));
      directory = new FakeDirectory();
      this.directories.set(name, directory);
    }
    return Promise.resolve(directory);
  }

  getFileHandle(name: string, options: { create?: boolean } = {}): Promise<unknown> {
    if (!this.files.has(name)) {
      if (!options.create) return Promise.reject(domError('NotFoundError'));
      const handle = new MemorySyncHandle();
      handle.closed = true;
      this.files.set(name, handle);
    }
    const handle = this.files.get(name) as MemorySyncHandle;
    return Promise.resolve({
      getFile: () => Promise.resolve(new File([handle.bytes.slice(0, handle.size)], name)),
      createSyncAccessHandle: () => {
        if (!handle.closed) return Promise.reject(domError('NoModificationAllowedError'));
        handle.closed = false;
        return Promise.resolve(handle);
      },
    });
  }

  removeEntry(name: string): Promise<void> {
    this.removeAttempts += 1;
    const handle = this.files.get(name);
    if (!handle) return Promise.reject(domError('NotFoundError'));
    const after = this.releaseAfter.get(name);
    if (after !== undefined && this.removeAttempts > after) handle.closed = true;
    if (!handle.closed) return Promise.reject(domError('NoModificationAllowedError'));
    this.files.delete(name);
    return Promise.resolve();
  }

  async *entries(): AsyncIterable<[string, { kind: string }]> {
    await Promise.resolve();
    for (const name of this.directories.keys()) yield [name, { kind: 'directory' }];
    for (const name of this.files.keys()) yield [name, { kind: 'file' }];
  }
}

describe('merged file names (0.4.0)', () => {
  it('names a file per task and attempt, with the container’s extension, valid for FFmpeg', () => {
    const taskId = '0b6f7a5e-3c1d-4e8f-9a2b-1c3d5e7f9a0b'; // task IDs are UUIDs
    const name = mergeFileName(taskId, 'mp4', 'lz2k9f0a1');
    expect(name).toBe(`${taskId}.lz2k9f0a1.mp4`);
    expect(isValidFileName(name ?? '')).toBe(true);
    expect(mergeFileName(taskId, 'mkv', 'lz2k9f0a2')).toBe(`${taskId}.lz2k9f0a2.mkv`);
    expect(taskIdOfMergeFile(name ?? '')).toBe(taskId);
  });

  it('gives no name for a task ID that cannot be part of one, and no task for a name it did not make', () => {
    expect(mergeFileName('../x', 'mp4', 'a1')).toBeUndefined();
    expect(mergeFileName('a.b', 'mp4', 'a1')).toBeUndefined();
    expect(mergeFileName('t', 'mp4', 'A.1')).toBeUndefined();
    expect(taskIdOfMergeFile('stray.bin')).toBeUndefined();
    expect(taskIdOfMergeFile('a.b.c.mp4')).toBeUndefined();
  });
});

describe('OpfsOutputFiles (0.4.0)', () => {
  const setup = () => {
    const root = new FakeDirectory();
    return { root, files: new OpfsOutputFiles(() => Promise.resolve(root)) };
  };

  it('opens an empty file in the merge directory for synchronous writing, and reads it back once closed', async () => {
    const { root, files } = setup();
    expect(await files.names()).toEqual([]); // no directory yet
    const first = await files.open('t.k1.mp4');
    first.handle.write(new Uint8Array([1, 2, 3]), { at: 0 });
    first.handle.close();
    const again = await files.open('t.k1.mp4'); // emptied
    expect(again.handle.getSize()).toBe(0);
    again.handle.write(new Uint8Array([4, 5]), { at: 0 });
    again.handle.close();
    expect([...new Uint8Array(await (await again.read()).arrayBuffer())]).toEqual([4, 5]);
    expect([...(root.directories.get(MERGE_DIRECTORY)?.files.keys() ?? [])]).toEqual(['t.k1.mp4']);
    await expect(files.open('t.k1.mp4').then(() => files.open('t.k1.mp4'))).rejects.toThrow('NoModificationAllowedError');
  });

  it('lists only files and removes them: missing, removed, or locked while open', async () => {
    const { root, files } = setup();
    await files.open('open.k1.mp4');
    (await files.open('done.k1.mp4')).handle.close();
    await (await root.getDirectoryHandle(MERGE_DIRECTORY)).getDirectoryHandle('nested', { create: true });
    expect((await files.names()).sort()).toEqual(['done.k1.mp4', 'open.k1.mp4']);
    expect(await files.remove('done.k1.mp4')).toBe('removed');
    expect(await files.remove('done.k1.mp4')).toBe('missing');
    expect(await files.remove('open.k1.mp4')).toBe('locked');
    expect(await new OpfsOutputFiles(() => Promise.resolve(new FakeDirectory())).remove('x.k1.mp4')).toBe('missing');
  });

  it('waits for a file whose worker is letting go of it, up to waitLockedMs', async () => {
    const { root, files } = setup();
    await files.open('t.k1.mp4');
    const directory = root.directories.get(MERGE_DIRECTORY) as FakeDirectory;
    directory.releaseAfter.set('t.k1.mp4', 2); // released between the second and third attempt
    expect(await files.remove('t.k1.mp4', { waitLockedMs: 1_000 })).toBe('removed');
    expect(directory.removeAttempts).toBe(3);
  });

  it('passes on errors other than a missing or locked file', async () => {
    const root = new FakeDirectory();
    root.removeEntry = () => Promise.reject(new DOMException('denied', 'SecurityError'));
    const directory = await root.getDirectoryHandle(MERGE_DIRECTORY, { create: true });
    directory.removeEntry = () => Promise.reject(new DOMException('denied', 'SecurityError'));
    await expect(new OpfsOutputFiles(() => Promise.resolve(root)).remove('t.k1.mp4')).rejects.toThrow('denied');
    await expect(new OpfsOutputFiles(() => Promise.reject(new TypeError('no OPFS'))).open('t.k1.mp4')).rejects.toThrow('no OPFS');
  });
});
