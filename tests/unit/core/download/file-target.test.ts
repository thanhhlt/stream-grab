import { describe, expect, it } from 'vitest';
import {
  DiskTarget,
  FLUSH_BYTES,
  ifRangeValue,
  MemoryTarget,
  parseContentRange,
  responseRecord,
  resumePoint,
  unsatisfiedTotal,
} from '@/core/download/file-target';
import { SyncPartialFiles } from '@/core/download/partial-files';
import { MemoryOutputFiles } from '@tests/fakes/output-files';

const response = (status: number, headers: Record<string, string>) => ({ status, headers: new Headers(headers) });

describe('validators and ranges (0.6.0)', () => {
  it('keeps a strong ETag, else a Last-Modified date, and the total size', () => {
    expect(responseRecord(response(200, { etag: '"abc"', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT', 'content-length': '10' }))).toEqual({
      etag: '"abc"',
      total: 10,
    });
    expect(responseRecord(response(200, { etag: 'W/"abc"', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' }))).toEqual({
      lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT',
    });
    expect(responseRecord(response(206, { etag: '"abc"', 'content-range': 'bytes 0-9/500' }))).toEqual({ etag: '"abc"', total: 500 });
    expect(responseRecord(response(200, { etag: 'W/"abc"', 'last-modified': 'not a date', 'content-length': '0' }))).toEqual({});
  });

  it('keeps no validator for a compressed body or a server that refuses ranges', () => {
    expect(responseRecord(response(200, { etag: '"abc"', 'content-encoding': 'gzip', 'content-length': '10' }))).toEqual({ total: 10 });
    expect(responseRecord(response(200, { etag: '"abc"', 'content-encoding': 'identity' }))).toEqual({ etag: '"abc"' });
    expect(responseRecord(response(200, { etag: '"abc"', 'accept-ranges': 'none' }))).toEqual({});
  });

  it('continues only what has a validator and fits the total', () => {
    expect(ifRangeValue({ etag: '"a"', lastModified: 'x' })).toBe('"a"');
    expect(ifRangeValue({ total: 5 })).toBeUndefined();
    expect(resumePoint({ size: 0, record: { etag: '"a"' } })).toBe(0);
    expect(resumePoint({ size: 4, record: undefined })).toBe(0);
    expect(resumePoint({ size: 4, record: { total: 9 } })).toBe(0);
    expect(resumePoint({ size: 4, record: { etag: '"a"', total: 9 } })).toBe(4);
    expect(resumePoint({ size: 10, record: { etag: '"a"', total: 9 } })).toBe(0);
  });

  it('reads Content-Range of a 206 and of a 416', () => {
    expect(parseContentRange('bytes 100-199/1000')).toEqual({ start: 100, end: 199, total: 1000 });
    expect(parseContentRange('bytes 100-199/*')).toEqual({ start: 100, end: 199 });
    expect(parseContentRange('bytes 200-100/1000')).toBeUndefined();
    expect(parseContentRange(null)).toBeUndefined();
    expect(unsatisfiedTotal('bytes */1000')).toBe(1000);
    expect(unsatisfiedTotal('bytes 0-1/1000')).toBeUndefined();
  });
});

describe('DiskTarget (0.6.0)', () => {
  it('records the response before its bytes, continues across opens, and deletes both files', async () => {
    const disk = new MemoryOutputFiles();
    const store = new SyncPartialFiles(disk);
    const first = (await DiskTarget.open(store, 't', 'webm')) as DiskTarget;
    expect(first.size).toBe(0);
    expect(first.record).toBeUndefined();
    await first.restart({ etag: '"v1"', total: 6 });
    await first.append(new Uint8Array([1, 2, 3]));
    await first.release();

    const second = (await DiskTarget.open(store, 't', 'webm')) as DiskTarget;
    expect(second.size).toBe(3);
    expect(second.record).toEqual({ etag: '"v1"', total: 6 });
    await second.append(new Uint8Array([4, 5, 6]));
    const blob = await second.complete('video/webm');
    expect(blob.type).toBe('video/webm');
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3, 4, 5, 6]);
    await second.discard();
    expect(await disk.names()).toEqual([]);
  });

  it('ignores a record it cannot read, and has no file for a task ID that cannot name one', async () => {
    const disk = new MemoryOutputFiles();
    const store = new SyncPartialFiles(disk);
    await store.put('t.json', new TextEncoder().encode('{"v":2,"etag":"\\"x\\""}'));
    const newer = await DiskTarget.open(store, 't', 'mp4');
    expect(newer?.record).toBeUndefined();
    await newer?.release();
    await store.put('t.json', new TextEncoder().encode('not json'));
    const broken = await DiskTarget.open(store, 't', 'mp4');
    expect(broken?.record).toBeUndefined();
    await broken?.release();
    expect(await DiskTarget.open(store, 'a/b', 'mp4')).toBeUndefined();
  });

  it('flushes every FLUSH_BYTES written', async () => {
    const disk = new MemoryOutputFiles();
    const target = (await DiskTarget.open(new SyncPartialFiles(disk), 't', 'mp4')) as DiskTarget;
    await target.restart({});
    const flushes = () => disk.files.get('t.mp4')?.flushes ?? 0;
    await target.append(new Uint8Array(FLUSH_BYTES - 1));
    expect(flushes()).toBe(0);
    await target.append(new Uint8Array(1));
    expect(flushes()).toBe(1);
    await target.release();
  });
});

describe('MemoryTarget (0.6.0)', () => {
  it('holds parts for its run and starts over on restart', async () => {
    const target = new MemoryTarget();
    await target.restart({ etag: '"a"' });
    await target.append(new Uint8Array([1, 2]));
    expect(target).toMatchObject({ size: 2, record: { etag: '"a"' } });
    await target.restart({});
    await target.append(new Uint8Array([3]));
    expect([...new Uint8Array(await (await target.complete('video/mp4')).arrayBuffer())]).toEqual([3]);
  });
});
