import type {
  RemovableKeyValueArea,
  StorageChange,
  StorageChangeEvents,
  StorageChangeListener,
} from '@/shared/storage/storage-area';

/**
 * In-memory stand-in for a chrome.storage area. Like the real API, values are
 * structured-cloned on the way in and out, and writes fire onChanged.
 */
export class FakeStorageArea implements RemovableKeyValueArea {
  readonly data = new Map<string, unknown>();
  readonly events: FakeStorageEvents;
  readonly areaName: string;
  failWrites = false;
  writeCount = 0;
  /** Size of everything written, as JSON: what each write costs Chrome to store and to deliver in onChanged. */
  bytesWritten = 0;

  constructor(areaName = 'local', events = new FakeStorageEvents()) {
    this.areaName = areaName;
    this.events = events;
  }

  get(key: string): Promise<Record<string, unknown>> {
    return Promise.resolve(this.data.has(key) ? { [key]: structuredClone(this.data.get(key)) } : {});
  }

  async set(items: Record<string, unknown>): Promise<void> {
    await Promise.resolve();
    if (this.failWrites) throw new Error('QUOTA_BYTES quota exceeded');
    this.writeCount += 1;
    this.bytesWritten += JSON.stringify(items).length;
    const changes: Record<string, StorageChange> = {};
    for (const [key, value] of Object.entries(items)) {
      changes[key] = { oldValue: structuredClone(this.data.get(key)), newValue: structuredClone(value) };
      this.data.set(key, structuredClone(value));
    }
    this.events.emit(changes, this.areaName);
  }

  async remove(keys: string | string[]): Promise<void> {
    await Promise.resolve();
    const changes: Record<string, StorageChange> = {};
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (!this.data.has(key)) continue;
      changes[key] = { oldValue: structuredClone(this.data.get(key)) };
      this.data.delete(key);
    }
    if (Object.keys(changes).length > 0) this.events.emit(changes, this.areaName);
  }
}

export class FakeStorageEvents implements StorageChangeEvents {
  readonly listeners = new Set<StorageChangeListener>();

  addListener(listener: StorageChangeListener): void {
    this.listeners.add(listener);
  }

  removeListener(listener: StorageChangeListener): void {
    this.listeners.delete(listener);
  }

  emit(changes: Record<string, StorageChange>, areaName: string): void {
    for (const listener of this.listeners) listener(changes, areaName);
  }
}
