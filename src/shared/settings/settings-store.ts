import { STORAGE_KEYS } from '@/shared/constants';
import type { KeyValueArea, StorageChangeEvents, StorageChangeListener } from '@/shared/storage/storage-area';
import { errorMessage, StreamGrabError } from '@/shared/utils/errors';
import { DEFAULT_SETTINGS, normalizeSettings, settingsEqual, type Settings } from './settings';

export type SettingsListener = (settings: Settings) => void;

/**
 * Persistent user settings in chrome.storage.local.
 *
 * Usable from the service worker and the popup. The offscreen document has no
 * chrome.storage access and receives settings through messages instead.
 * Values are normalised on every read, so stale or corrupted storage can never
 * produce an invalid Settings object.
 */
export class SettingsStore {
  readonly #area: KeyValueArea;
  readonly #areaName: string;
  readonly #events: StorageChangeEvents;
  /** Serialises read-modify-write updates issued from this context (e.g. a dragged slider). */
  #writeChain: Promise<unknown> = Promise.resolve();

  constructor(area: KeyValueArea, areaName: string, events: StorageChangeEvents) {
    this.#area = area;
    this.#areaName = areaName;
    this.#events = events;
  }

  async load(): Promise<Settings> {
    try {
      const items = await this.#area.get(STORAGE_KEYS.settings);
      return normalizeSettings(items[STORAGE_KEYS.settings]);
    } catch (error) {
      throw new StreamGrabError(`Could not read settings: ${errorMessage(error)}`, 'STORAGE_FAILED', { cause: error });
    }
  }

  /** Applies a partial update. Invalid values in `patch` keep the current value. */
  update(patch: Partial<Settings>): Promise<Settings> {
    return this.#enqueue(async () => {
      const current = await this.load();
      const next = normalizeSettings({ ...current, ...patch }, current);
      if (!settingsEqual(current, next)) await this.#write(next);
      return next;
    });
  }

  reset(): Promise<Settings> {
    return this.#enqueue(async () => {
      const next = { ...DEFAULT_SETTINGS };
      await this.#write(next);
      return next;
    });
  }

  /** Persists normalised settings (fills defaults on install, migrates old shapes on update). */
  initialize(): Promise<Settings> {
    return this.#enqueue(async () => {
      const items = await this.#area.get(STORAGE_KEYS.settings);
      const next = normalizeSettings(items[STORAGE_KEYS.settings]);
      await this.#write(next);
      return next;
    });
  }

  /** Notifies about changes made by any extension context. Returns an unsubscribe function. */
  subscribe(listener: SettingsListener): () => void {
    const onChanged: StorageChangeListener = (changes, areaName) => {
      const change = changes[STORAGE_KEYS.settings];
      if (areaName !== this.#areaName || change === undefined) return;
      listener(normalizeSettings(change.newValue));
    };
    this.#events.addListener(onChanged);
    return () => {
      this.#events.removeListener(onChanged);
    };
  }

  async #write(settings: Settings): Promise<void> {
    try {
      await this.#area.set({ [STORAGE_KEYS.settings]: settings });
    } catch (error) {
      throw new StreamGrabError(`Could not save settings: ${errorMessage(error)}`, 'STORAGE_FAILED', { cause: error });
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#writeChain.then(operation, operation);
    this.#writeChain = result.catch(() => undefined);
    return result;
  }
}

let defaultStore: SettingsStore | undefined;

/** Store backed by chrome.storage.local, created on first use. */
export function getSettingsStore(): SettingsStore {
  defaultStore ??= new SettingsStore(chrome.storage.local, 'local', chrome.storage.onChanged);
  return defaultStore;
}
