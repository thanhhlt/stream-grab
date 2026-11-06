import type { TrackLayout } from '@/core/models/media-info';
import { parseLayout } from './track-layout';

/**
 * Temporary storage of downloaded segment data in IndexedDB (extension
 * origin, shared by the service worker and the offscreen document).
 *
 * Object stores:
 * - `parts`: segment bytes. Each segment is stored as one or more parts
 *   (large bodies are written in chunks as they arrive) keyed by
 *   [taskId, trackId, index, part], so the merge step reads every track in
 *   output order regardless of download order. Data is stored as Blobs, which
 *   Chrome keeps on disk; reading a part back returns a Blob handle without
 *   loading it into memory.
 * - `segments`: completion markers, [taskId, trackId, index] → bytes and part
 *   count. A marker is written only after the segment's last part, and
 *   deleted together with its parts, so parts without a marker are an
 *   interrupted write: parts alone never prove a segment complete.
 * - `plans`: per task, the signature of the segment list the data belongs
 *   to. A run whose segment list differs (the video changed on the server)
 *   starts over instead of mixing two versions. Since Phase 8 the plan also
 *   holds the tracks' layout (init segments, discontinuities, containers, no
 *   URLs), which media processing needs to assemble each track.
 */

export interface SegmentKey {
  taskId: string;
  trackId: string;
  /** Segment position within its track. */
  index: number;
}

export interface PartKey extends SegmentKey {
  /** Chunk of that segment, from 0. */
  part: number;
}

export interface StoredPart extends PartKey {
  size: number;
}

/** A stored part with its bytes (a disk-backed Blob handle). */
export interface StoredBlob {
  index: number;
  part: number;
  data: Blob;
}

/** A segment whose parts are all stored. */
export interface CompletedSegment extends SegmentKey {
  bytes: number;
  parts: number;
}

export interface StoredPlan {
  taskId: string;
  /** planSignature() of the segment list. */
  signature: string;
  segmentsTotal: number;
  updatedAt: number;
  /** Absent in plans stored before Phase 8; the next download run adds it. */
  layout?: TrackLayout[];
}

/** What a task has in storage (completion markers, not verified against the parts). */
export interface StoredSummary {
  segmentsTotal: number;
  segmentsDone: number;
  bytes: number;
}

/** Result of checking a task's stored data before resuming it. */
export interface StoredSegments {
  /** Segments with a marker and exactly the parts it names. */
  complete: CompletedSegment[];
  /** Segments with parts but no valid marker (interrupted writes), or a marker whose parts are missing. */
  incomplete: SegmentKey[];
}

export interface SegmentStorage {
  put(key: PartKey, data: Blob): Promise<void>;
  /** Marks a segment complete; call after its last part is stored. */
  completeSegment(segment: CompletedSegment): Promise<void>;
  /** Removes all parts of one segment and its marker (before retrying it). */
  deleteSegment(taskId: string, trackId: string, index: number): Promise<void>;
  /** Same for several segments, in one transaction. */
  deleteSegments(taskId: string, segments: readonly Omit<SegmentKey, 'taskId'>[]): Promise<void>;
  /** Removes everything of a task: parts, markers, plan. */
  deleteTask(taskId: string): Promise<void>;
  /** Replaces a task's data with an empty plan (fresh start), atomically. */
  resetTask(plan: StoredPlan): Promise<void>;
  /** Replaces the plan record only (same segment list, e.g. adding its layout); the data stays. */
  savePlan(plan: StoredPlan): Promise<void>;
  getPlan(taskId: string): Promise<StoredPlan | undefined>;
  /** Complete and incomplete segments of a task, checked against its parts. */
  inspectTask(taskId: string): Promise<StoredSegments>;
  summary(taskId: string): Promise<StoredSummary | undefined>;
  /** IDs of every task that has data of any kind. */
  taskIds(): Promise<string[]>;
  /** Parts of a task (optionally one track), ordered by track, index, part. */
  listParts(taskId: string, trackId?: string): Promise<StoredPart[]>;
  read(key: PartKey): Promise<Blob | undefined>;
  /**
   * The stored parts of one track with their Blobs, in output order (segment,
   * then part), read in one pass. Chrome returns disk-backed Blob handles: no
   * bytes are loaded.
   */
  trackData(taskId: string, trackId: string): Promise<StoredBlob[]>;
}

interface PartRecord extends StoredPart {
  data: Blob;
}

const DB_VERSION = 2;
const PARTS = 'parts';
const SEGMENTS = 'segments';
const PLANS = 'plans';
const BY_TASK = 'byTask';
const ALL_STORES = [PARTS, SEGMENTS, PLANS];

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('IndexedDB request failed'));
    };
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onabort = () => {
      reject(tx.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError'));
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('IndexedDB transaction failed'));
    };
  });
}

/** Visits cursor results until the cursor ends. */
function each<C extends IDBCursor>(req: IDBRequest<C | null>, visit: (cursor: C) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve();
        return;
      }
      visit(cursor);
      cursor.continue();
    };
    req.onerror = () => {
      reject(req.error ?? new Error('IndexedDB cursor failed'));
    };
  });
}

const keyOf = (key: PartKey): IDBValidKey => [key.taskId, key.trackId, key.index, key.part];
/** Every key that starts with taskId: arrays sort after strings and numbers. */
const taskRange = (taskId: string): IDBKeyRange => IDBKeyRange.bound([taskId], [taskId, []]);
const trackRange = (taskId: string, trackId: string): IDBKeyRange =>
  IDBKeyRange.bound([taskId, trackId, 0, 0], [taskId, trackId, Infinity, Infinity]);
const segmentPartsRange = (taskId: string, trackId: string, index: number): IDBKeyRange =>
  IDBKeyRange.bound([taskId, trackId, index, 0], [taskId, trackId, index, Infinity]);
const segmentId = (trackId: string, index: number): string => `${index}:${trackId}`;

export class IndexedDbSegmentStorage implements SegmentStorage {
  readonly #factory: IDBFactory;
  readonly #name: string;
  #db: Promise<IDBDatabase> | undefined;

  constructor(factory: IDBFactory = indexedDB, name = 'streamgrab-segments') {
    this.#factory = factory;
    this.#name = name;
  }

  async put(key: PartKey, data: Blob): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction(PARTS, 'readwrite');
    const record: PartRecord = { ...key, size: data.size, data };
    tx.objectStore(PARTS).put(record);
    await done(tx);
  }

  async completeSegment(segment: CompletedSegment): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction(SEGMENTS, 'readwrite');
    const { taskId, trackId, index, bytes, parts } = segment;
    tx.objectStore(SEGMENTS).put({ taskId, trackId, index, bytes, parts } satisfies CompletedSegment);
    await done(tx);
  }

  deleteSegment(taskId: string, trackId: string, index: number): Promise<void> {
    return this.deleteSegments(taskId, [{ trackId, index }]);
  }

  async deleteSegments(taskId: string, segments: readonly Omit<SegmentKey, 'taskId'>[]): Promise<void> {
    if (segments.length === 0) return;
    const db = await this.#open();
    const tx = db.transaction([PARTS, SEGMENTS], 'readwrite');
    for (const { trackId, index } of segments) {
      // Marker and parts go together: a marker never outlives its data.
      tx.objectStore(SEGMENTS).delete([taskId, trackId, index]);
      tx.objectStore(PARTS).delete(segmentPartsRange(taskId, trackId, index));
    }
    await done(tx);
  }

  async deleteTask(taskId: string): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction(ALL_STORES, 'readwrite');
    tx.objectStore(PLANS).delete(taskId);
    tx.objectStore(SEGMENTS).delete(taskRange(taskId));
    tx.objectStore(PARTS).delete(taskRange(taskId));
    await done(tx);
  }

  async resetTask(plan: StoredPlan): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction(ALL_STORES, 'readwrite');
    tx.objectStore(SEGMENTS).delete(taskRange(plan.taskId));
    tx.objectStore(PARTS).delete(taskRange(plan.taskId));
    tx.objectStore(PLANS).put({ ...plan });
    await done(tx);
  }

  async savePlan(plan: StoredPlan): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction(PLANS, 'readwrite');
    tx.objectStore(PLANS).put({ ...plan });
    await done(tx);
  }

  async getPlan(taskId: string): Promise<StoredPlan | undefined> {
    const db = await this.#open();
    const record = (await request(db.transaction(PLANS, 'readonly').objectStore(PLANS).get(taskId))) as unknown;
    return parsePlan(record);
  }

  async inspectTask(taskId: string): Promise<StoredSegments> {
    const db = await this.#open();
    const tx = db.transaction([PARTS, SEGMENTS], 'readonly');
    const markers: CompletedSegment[] = [];
    /** Part numbers stored per segment (keys only: the Blobs are not touched). */
    const parts = new Map<string, { trackId: string; index: number; numbers: number[] }>();
    await Promise.all([
      each(tx.objectStore(SEGMENTS).openCursor(taskRange(taskId)), (cursor) => {
        const marker = parseMarker(cursor.value);
        if (marker) markers.push(marker);
      }),
      each(tx.objectStore(PARTS).openKeyCursor(taskRange(taskId)), (cursor) => {
        const key = cursor.primaryKey;
        if (!Array.isArray(key)) return;
        const [, trackId, index, part] = key as unknown[];
        if (typeof trackId !== 'string' || typeof index !== 'number' || typeof part !== 'number') return;
        const id = segmentId(trackId, index);
        const entry = parts.get(id) ?? { trackId, index, numbers: [] };
        entry.numbers.push(part);
        parts.set(id, entry);
      }),
    ]);
    const complete: CompletedSegment[] = [];
    const incomplete: SegmentKey[] = [];
    for (const marker of markers) {
      const id = segmentId(marker.trackId, marker.index);
      const numbers = parts.get(id)?.numbers ?? [];
      parts.delete(id);
      // Parts are listed in key order: complete means exactly 0 … parts-1.
      if (numbers.length === marker.parts && numbers.every((part, i) => part === i)) complete.push(marker);
      else incomplete.push({ taskId, trackId: marker.trackId, index: marker.index });
    }
    for (const { trackId, index } of parts.values()) incomplete.push({ taskId, trackId, index });
    return { complete, incomplete };
  }

  async summary(taskId: string): Promise<StoredSummary | undefined> {
    const db = await this.#open();
    const tx = db.transaction([PLANS, SEGMENTS], 'readonly');
    const plan = parsePlan(await request(tx.objectStore(PLANS).get(taskId)));
    if (!plan) return undefined;
    let segmentsDone = 0;
    let bytes = 0;
    await each(tx.objectStore(SEGMENTS).openCursor(taskRange(taskId)), (cursor) => {
      const marker = parseMarker(cursor.value);
      if (!marker) return;
      segmentsDone += 1;
      bytes += marker.bytes;
    });
    return { segmentsTotal: plan.segmentsTotal, segmentsDone: Math.min(segmentsDone, plan.segmentsTotal), bytes };
  }

  async taskIds(): Promise<string[]> {
    const db = await this.#open();
    const tx = db.transaction(ALL_STORES, 'readonly');
    const ids = new Set<string>();
    const collect = (cursor: IDBCursor): void => {
      if (typeof cursor.key === 'string') ids.add(cursor.key);
    };
    await Promise.all([
      // One step per task, not per part.
      each(tx.objectStore(PARTS).index(BY_TASK).openKeyCursor(null, 'nextunique'), collect),
      each(tx.objectStore(SEGMENTS).index(BY_TASK).openKeyCursor(null, 'nextunique'), collect),
      each(tx.objectStore(PLANS).openKeyCursor(), collect),
    ]);
    return [...ids];
  }

  async listParts(taskId: string, trackId?: string): Promise<StoredPart[]> {
    const db = await this.#open();
    const tx = db.transaction(PARTS, 'readonly');
    const range = trackId === undefined ? taskRange(taskId) : trackRange(taskId, trackId);
    // The records' Blobs are disk-backed handles; their bytes are not read here.
    const parts: StoredPart[] = [];
    await each(tx.objectStore(PARTS).openCursor(range), (cursor) => {
      const { taskId: t, trackId: track, index, part, size } = cursor.value as PartRecord;
      parts.push({ taskId: t, trackId: track, index, part, size });
    });
    return parts;
  }

  async trackData(taskId: string, trackId: string): Promise<StoredBlob[]> {
    const db = await this.#open();
    const tx = db.transaction(PARTS, 'readonly');
    const parts: StoredBlob[] = [];
    await each(tx.objectStore(PARTS).openCursor(trackRange(taskId, trackId)), (cursor) => {
      const record = cursor.value as Partial<PartRecord>;
      if (record.data instanceof Blob && typeof record.index === 'number' && typeof record.part === 'number') {
        parts.push({ index: record.index, part: record.part, data: record.data });
      }
    });
    return parts;
  }

  async read(key: PartKey): Promise<Blob | undefined> {
    const db = await this.#open();
    const record = (await request(db.transaction(PARTS, 'readonly').objectStore(PARTS).get(keyOf(key)))) as
      | PartRecord
      | undefined;
    return record?.data;
  }

  #open(): Promise<IDBDatabase> {
    this.#db ??= new Promise((resolve, reject) => {
      const open = this.#factory.open(this.#name, DB_VERSION);
      open.onupgradeneeded = (event) => {
        const db = open.result;
        // Version 1 (Phase 6) had only `parts`; its parts have no markers, so they count as incomplete.
        if (event.oldVersion < 1) {
          db.createObjectStore(PARTS, { keyPath: ['taskId', 'trackId', 'index', 'part'] }).createIndex(BY_TASK, 'taskId');
        }
        if (event.oldVersion < 2) {
          db.createObjectStore(SEGMENTS, { keyPath: ['taskId', 'trackId', 'index'] }).createIndex(BY_TASK, 'taskId');
          db.createObjectStore(PLANS, { keyPath: 'taskId' });
        }
      };
      open.onsuccess = () => {
        const db = open.result;
        // Another context upgrading the database (an updated extension) needs this connection closed.
        db.onversionchange = () => {
          db.close();
          this.#db = undefined;
        };
        resolve(db);
      };
      open.onerror = () => {
        reject(open.error ?? new Error('Could not open IndexedDB'));
      };
    });
    this.#db.catch(() => {
      this.#db = undefined;
    });
    return this.#db;
  }
}

function parseMarker(raw: unknown): CompletedSegment | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { taskId, trackId, index, bytes, parts } = raw as Record<string, unknown>;
  if (typeof taskId !== 'string' || typeof trackId !== 'string') return undefined;
  if (![index, bytes, parts].every((value) => typeof value === 'number' && Number.isInteger(value) && value >= 0)) return undefined;
  return { taskId, trackId, index: index as number, bytes: bytes as number, parts: parts as number };
}

function parsePlan(raw: unknown): StoredPlan | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { taskId, signature, segmentsTotal, updatedAt } = raw as Record<string, unknown>;
  if (typeof taskId !== 'string' || typeof signature !== 'string') return undefined;
  if (typeof segmentsTotal !== 'number' || !Number.isInteger(segmentsTotal) || segmentsTotal < 0) return undefined;
  const plan: StoredPlan = { taskId, signature, segmentsTotal, updatedAt: typeof updatedAt === 'number' ? updatedAt : 0 };
  // A damaged layout counts as none: the next download run writes it again.
  const layout = parseLayout((raw as Record<string, unknown>)['layout']);
  if (layout) plan.layout = layout;
  return plan;
}
