/**
 * Minimal views of chrome.storage areas and events. Code depends on these
 * instead of the chrome globals so it can run against in-memory fakes in tests.
 */

/** The subset of chrome.storage.StorageArea used by stores. */
export interface KeyValueArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface RemovableKeyValueArea extends KeyValueArea {
  remove(keys: string | string[]): Promise<void>;
}

export interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

export type StorageChangeListener = (changes: Record<string, StorageChange>, areaName: string) => void;

/** The subset of chrome.storage.onChanged used by stores. */
export interface StorageChangeEvents {
  addListener(listener: StorageChangeListener): void;
  removeListener(listener: StorageChangeListener): void;
}
