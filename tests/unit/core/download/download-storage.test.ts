import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { IndexedDbSegmentStorage } from '@/core/download/download-storage';

const blob = (text: string) => new Blob([text]);

function storage() {
  return new IndexedDbSegmentStorage(new IDBFactory());
}

describe('IndexedDbSegmentStorage', () => {
  it('lists parts in output order whatever the write order', async () => {
    const store = storage();
    await store.put({ taskId: 't', trackId: 'main', index: 2, part: 0 }, blob('c'));
    await store.put({ taskId: 't', trackId: 'main', index: 0, part: 1 }, blob('a2'));
    await store.put({ taskId: 't', trackId: 'audio-0', index: 0, part: 0 }, blob('x'));
    await store.put({ taskId: 't', trackId: 'main', index: 0, part: 0 }, blob('a1'));
    await store.put({ taskId: 't', trackId: 'main', index: 10, part: 0 }, blob('k'));
    await store.put({ taskId: 'other', trackId: 'main', index: 0, part: 0 }, blob('o'));

    const main = await store.listParts('t', 'main');
    expect(main.map((p) => [p.index, p.part, p.size])).toEqual([
      [0, 0, 2],
      [0, 1, 2],
      [2, 0, 1],
      [10, 0, 1],
    ]);
    expect((await store.listParts('t')).map((p) => p.trackId)).toEqual(['audio-0', 'main', 'main', 'main', 'main']);
    const text = await Promise.all(main.map(async (p) => (await store.read(p))?.text()));
    expect(text.join('')).toBe('a1a2ck');
  });

  it('deletes one segment (before a retry) and whole tasks', async () => {
    const store = storage();
    await store.put({ taskId: 't', trackId: 'main', index: 0, part: 0 }, blob('a'));
    await store.put({ taskId: 't', trackId: 'main', index: 1, part: 0 }, blob('b'));
    await store.put({ taskId: 't', trackId: 'main', index: 1, part: 1 }, blob('b'));
    await store.put({ taskId: 'u', trackId: 'main', index: 0, part: 0 }, blob('u'));
    await store.deleteSegment('t', 'main', 1);
    expect((await store.listParts('t')).map((p) => p.index)).toEqual([0]);
    await store.deleteTask('t');
    expect(await store.listParts('t')).toEqual([]);
    expect(await store.listParts('u')).toHaveLength(1);
    expect(await store.read({ taskId: 't', trackId: 'main', index: 0, part: 0 })).toBeUndefined();
  });

  describe('resume bookkeeping', () => {
    const plan = (taskId: string, segmentsTotal = 10) => ({ taskId, signature: `sig-${taskId}`, segmentsTotal, updatedAt: 7 });

    it('counts a segment complete only with its marker and every part it names', async () => {
      const store = storage();
      await store.resetTask(plan('t'));
      // seg 0: two parts, marked. seg 1: marked, but part 1 is missing. seg 2: parts, no marker (interrupted).
      // seg 3: marked with a gap in its parts. seg 4: marker without any part.
      await store.put({ taskId: 't', trackId: 'main', index: 0, part: 0 }, blob('aa'));
      await store.put({ taskId: 't', trackId: 'main', index: 0, part: 1 }, blob('a'));
      await store.completeSegment({ taskId: 't', trackId: 'main', index: 0, bytes: 3, parts: 2 });
      await store.put({ taskId: 't', trackId: 'main', index: 1, part: 0 }, blob('b'));
      await store.completeSegment({ taskId: 't', trackId: 'main', index: 1, bytes: 2, parts: 2 });
      await store.put({ taskId: 't', trackId: 'main', index: 2, part: 0 }, blob('c'));
      await store.put({ taskId: 't', trackId: 'main', index: 3, part: 0 }, blob('d'));
      await store.put({ taskId: 't', trackId: 'main', index: 3, part: 2 }, blob('d'));
      await store.completeSegment({ taskId: 't', trackId: 'main', index: 3, bytes: 2, parts: 2 });
      await store.completeSegment({ taskId: 't', trackId: 'main', index: 4, bytes: 9, parts: 1 });
      await store.put({ taskId: 't', trackId: 'audio-0', index: 0, part: 0 }, blob('x'));
      await store.completeSegment({ taskId: 't', trackId: 'audio-0', index: 0, bytes: 1, parts: 1 });

      const { complete, incomplete } = await store.inspectTask('t');
      expect(complete.map((s) => [s.trackId, s.index, s.bytes])).toEqual([
        ['audio-0', 0, 1],
        ['main', 0, 3],
      ]);
      expect(incomplete.map((s) => [s.trackId, s.index]).sort()).toEqual([
        ['main', 1],
        ['main', 2],
        ['main', 3],
        ['main', 4],
      ]);
      // Markers only, unverified: what the service worker shows before the engine checks.
      expect(await store.summary('t')).toEqual({ segmentsTotal: 10, segmentsDone: 5, bytes: 17 });

      await store.deleteSegments('t', incomplete);
      expect((await store.inspectTask('t')).incomplete).toEqual([]);
      expect(await store.summary('t')).toEqual({ segmentsTotal: 10, segmentsDone: 2, bytes: 4 });
    });

    it('deletes a segment together with its marker', async () => {
      const store = storage();
      await store.put({ taskId: 't', trackId: 'main', index: 0, part: 0 }, blob('a'));
      await store.completeSegment({ taskId: 't', trackId: 'main', index: 0, bytes: 1, parts: 1 });
      await store.deleteSegment('t', 'main', 0);
      expect(await store.inspectTask('t')).toEqual({ complete: [], incomplete: [] });
    });

    it('resets a task to an empty plan and deletes tasks across every store', async () => {
      const store = storage();
      await store.resetTask(plan('t'));
      await store.put({ taskId: 't', trackId: 'main', index: 0, part: 0 }, blob('a'));
      await store.completeSegment({ taskId: 't', trackId: 'main', index: 0, bytes: 1, parts: 1 });
      await store.resetTask({ ...plan('t', 4), signature: 'other' });
      expect(await store.getPlan('t')).toEqual({ taskId: 't', signature: 'other', segmentsTotal: 4, updatedAt: 7 });
      expect(await store.listParts('t')).toEqual([]);
      expect(await store.summary('t')).toEqual({ segmentsTotal: 4, segmentsDone: 0, bytes: 0 });

      await store.deleteTask('t');
      expect(await store.getPlan('t')).toBeUndefined();
      expect(await store.summary('t')).toBeUndefined();
      expect(await store.taskIds()).toEqual([]);
    });

    it('keeps the track layout with the plan, and treats a damaged one as missing', async () => {
      const store = storage();
      const layout = [
        { trackId: 'main', trackType: 'main' as const, segments: 3, initIndexes: [0], discontinuityIndexes: [], container: 'fmp4' as const, durationSec: 8 },
      ];
      await store.resetTask({ ...plan('t', 3), layout });
      expect(await store.getPlan('t')).toEqual({ ...plan('t', 3), layout });
      // savePlan replaces the record only: stored segments stay.
      await store.put({ taskId: 't', trackId: 'main', index: 0, part: 0 }, blob('init'));
      await store.savePlan({ ...plan('t', 3), updatedAt: 9, layout: [{ ...layout[0]!, durationSec: 9 }] });
      expect((await store.getPlan('t'))?.layout?.[0]?.durationSec).toBe(9);
      expect(await store.listParts('t')).toHaveLength(1);
      await store.savePlan({ ...plan('t', 3), layout: [{ ...layout[0]!, initIndexes: [7] }] });
      expect(await store.getPlan('t')).toEqual(plan('t', 3));
    });

    it('hands back the Blobs of one track in output order', async () => {
      const store = storage();
      await store.put({ taskId: 't', trackId: 'main', index: 1, part: 1 }, blob('d'));
      await store.put({ taskId: 't', trackId: 'main', index: 0, part: 0 }, blob('a'));
      await store.put({ taskId: 't', trackId: 'audio-0', index: 0, part: 0 }, blob('x'));
      await store.put({ taskId: 't', trackId: 'main', index: 1, part: 0 }, blob('c'));
      await store.put({ taskId: 't', trackId: 'main', index: 0, part: 1 }, blob('b'));
      const parts = await store.trackData('t', 'main');
      expect(parts.map((part) => [part.index, part.part])).toEqual([
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 1],
      ]);
      expect(await new Blob(parts.map((part) => part.data)).text()).toBe('abcd');
      expect(await store.trackData('t', 'missing')).toEqual([]);
    });

    it('lists every task that has any data, once', async () => {
      const store = storage();
      await store.put({ taskId: 'parts-only', trackId: 'main', index: 0, part: 0 }, blob('a'));
      await store.put({ taskId: 'parts-only', trackId: 'main', index: 1, part: 0 }, blob('a'));
      await store.completeSegment({ taskId: 'marker-only', trackId: 'main', index: 0, bytes: 1, parts: 1 });
      await store.resetTask(plan('plan-only'));
      expect((await store.taskIds()).sort()).toEqual(['marker-only', 'parts-only', 'plan-only']);
    });

    it('upgrades a Phase 6 database: its parts stay, without markers they count as incomplete', async () => {
      const factory = new IDBFactory();
      await new Promise<void>((resolve, reject) => {
        const open = factory.open('streamgrab-segments', 1);
        open.onupgradeneeded = () => {
          open.result.createObjectStore('parts', { keyPath: ['taskId', 'trackId', 'index', 'part'] }).createIndex('byTask', 'taskId');
        };
        open.onsuccess = () => {
          const tx = open.result.transaction('parts', 'readwrite');
          tx.objectStore('parts').put({ taskId: 'old', trackId: 'main', index: 0, part: 0, size: 1, data: blob('a') });
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
        };
        open.onerror = () => {
          reject(open.error ?? new Error('open failed'));
        };
      });
      const store = new IndexedDbSegmentStorage(factory);
      expect(await store.listParts('old')).toHaveLength(1);
      expect(await store.getPlan('old')).toBeUndefined();
      expect(await store.inspectTask('old')).toEqual({ complete: [], incomplete: [{ taskId: 'old', trackId: 'main', index: 0 }] });
      expect(await store.taskIds()).toEqual(['old']);
    });
  });
});
