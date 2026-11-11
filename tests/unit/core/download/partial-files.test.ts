import { describe, expect, it } from 'vitest';
import {
  PartialFileHost,
  partialFileName,
  partialMetaName,
  SyncPartialFiles,
  taskIdOfPartialFile,
  WorkerPartialFiles,
  type WorkerLike,
} from '@/core/download/partial-files';
import { MemoryOutputFiles } from '@tests/fakes/output-files';

const bytes = (...values: number[]) => new Uint8Array(values);
const contents = async (blob: Blob | undefined) => [...new Uint8Array(await (blob as Blob).arrayBuffer())];

/** A dedicated worker running PartialFileHost, in process; records what was transferred. */
class FakeWorker implements WorkerLike {
  readonly host: PartialFileHost;
  readonly transferred: number[] = [];
  terminated = false;
  #message: ((event: MessageEvent) => void) | undefined;
  #error: ((event: Event) => void) | undefined;

  constructor(host: PartialFileHost) {
    this.host = host;
  }

  postMessage(message: unknown, transfer: Transferable[]): void {
    this.transferred.push(transfer.length);
    void this.host.handle(message).then((response) => this.#message?.(new MessageEvent('message', { data: response })));
  }

  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  addEventListener(type: 'error', listener: (event: Event) => void): void;
  addEventListener(type: 'message' | 'error', listener: ((event: MessageEvent) => void) | ((event: Event) => void)): void {
    if (type === 'message') this.#message = listener as (event: MessageEvent) => void;
    else this.#error = listener as (event: Event) => void;
  }

  crash(): void {
    this.#error?.(new Event('error'));
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe('progressive file names (0.6.0)', () => {
  it('names a task’s data file and record, and finds the task of a name', () => {
    const taskId = '0b6f7a5e-3c1d-4e8f-9a2b-1c3d5e7f9a0b';
    expect(partialFileName(taskId, 'mp4')).toBe(`${taskId}.mp4`);
    expect(partialFileName(taskId, 'webm')).toBe(`${taskId}.webm`);
    expect(partialMetaName(taskId)).toBe(`${taskId}.json`);
    expect(taskIdOfPartialFile(`${taskId}.webm`)).toBe(taskId);
    expect(taskIdOfPartialFile(`${taskId}.json`)).toBe(taskId);
    expect(partialFileName('../x', 'mp4')).toBeUndefined();
    expect(partialMetaName('a.b')).toBeUndefined();
    expect(taskIdOfPartialFile('a.k1.mp4')).toBeUndefined(); // a merged file's name
    expect(taskIdOfPartialFile('noextension')).toBeUndefined();
  });
});

describe('SyncPartialFiles (0.6.0)', () => {
  it('appends to what a file holds, flushes, and releases it on close', async () => {
    const disk = new MemoryOutputFiles();
    const store = new SyncPartialFiles(disk);
    const file = await store.open('t.mp4');
    expect(file.size).toBe(0);
    await file.append(bytes(1, 2));
    await file.flush();
    await file.close();
    await file.close(); // once
    const again = await store.open('t.mp4');
    expect(again.size).toBe(2);
    await again.append(bytes(3));
    await again.truncate(1);
    await again.append(bytes(9));
    await again.close();
    expect(await contents(await store.read('t.mp4'))).toEqual([1, 9]);
    expect(disk.files.get('t.mp4')).toMatchObject({ closed: true, flushes: 1 }); // closing flushes
  });

  it('replaces a small file in one go, and removes files', async () => {
    const disk = new MemoryOutputFiles();
    const store = new SyncPartialFiles(disk);
    await store.put('t.json', bytes(1, 2, 3));
    await store.put('t.json', bytes(4));
    expect(await contents(await store.read('t.json'))).toEqual([4]);
    expect(await store.remove('t.json')).toBe('removed');
    expect(await store.read('t.json')).toBeUndefined();
  });

  it('fails a write the disk has no room for', async () => {
    const disk = new MemoryOutputFiles();
    disk.quota = 2;
    const file = await new SyncPartialFiles(disk).open('t.mp4');
    await expect(file.append(bytes(1, 2, 3))).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(file.size).toBe(0);
  });
});

describe('WorkerPartialFiles and PartialFileHost (0.6.0)', () => {
  const setup = () => {
    const disk = new MemoryOutputFiles();
    const workers: FakeWorker[] = [];
    const files = new WorkerPartialFiles(() => {
      const worker = new FakeWorker(new PartialFileHost(new SyncPartialFiles(disk)));
      workers.push(worker);
      return worker;
    }, disk);
    return { disk, workers, files };
  };

  it('writes through the worker (transferring whole buffers), reads and removes here', async () => {
    const { disk, workers, files } = setup();
    expect(workers).toHaveLength(0); // started with the first file
    const file = await files.open('t.mp4');
    await file.append(bytes(1, 2, 3));
    await file.append(new Uint8Array(new ArrayBuffer(8), 2, 2)); // a view: copied, not transferred
    await file.flush();
    expect(file.size).toBe(5);
    await file.close();
    await files.put('t.json', bytes(7));
    expect(workers).toHaveLength(1);
    expect(workers[0]?.transferred).toEqual([0, 1, 0, 0, 0, 1]);
    expect(await contents(await files.read('t.mp4'))).toEqual([1, 2, 3, 0, 0]);
    expect(await files.remove('t.mp4')).toBe('removed');
    expect(await disk.names()).toEqual(['t.json']);
  });

  it('passes errors on by name: a full disk, a file opened twice or not open', async () => {
    const { disk, files } = setup();
    disk.quota = 1;
    const file = await files.open('t.mp4');
    await expect(file.append(bytes(1, 2))).rejects.toMatchObject({ name: 'QuotaExceededError' });
    await expect(files.open('t.mp4')).rejects.toMatchObject({ name: 'NoModificationAllowedError' });
    await file.close();
    await expect(file.flush()).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect((await files.open('t.mp4')).size).toBe(0); // free again once closed
  });

  it('fails pending requests when the worker crashes, and starts a new one for the next', async () => {
    const { workers, files } = setup();
    await files.open('a.mp4');
    const worker = workers[0] as FakeWorker;
    worker.host.handle = () => new Promise(() => undefined); // never answers
    const pending = files.open('b.mp4');
    worker.crash();
    await expect(pending).rejects.toThrow('The file worker stopped');
    expect(worker.terminated).toBe(true);
    await files.open('c.mp4');
    expect(workers).toHaveLength(2);
  });

  it('answers malformed requests with an error', async () => {
    const host = new PartialFileHost(new SyncPartialFiles(new MemoryOutputFiles()));
    expect(await host.handle({ id: 3, op: 'append', name: 't.mp4' })).toMatchObject({ id: 3, error: { message: 'Invalid file request' } });
    expect(await host.handle('nonsense')).toMatchObject({ id: -1 });
  });
});
