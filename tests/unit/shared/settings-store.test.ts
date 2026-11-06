import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '@/shared/constants';
import { DEFAULT_SETTINGS, type Settings } from '@/shared/settings/settings';
import { SettingsStore } from '@/shared/settings/settings-store';
import { StreamGrabError } from '@/shared/utils/errors';
import { FakeStorageArea } from '@tests/fakes/fake-storage';

describe('SettingsStore', () => {
  let area: FakeStorageArea;
  let store: SettingsStore;

  beforeEach(() => {
    area = new FakeStorageArea('local');
    store = new SettingsStore(area, 'local', area.events);
  });

  it('loads defaults when nothing is stored', async () => {
    await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('normalises corrupted stored values on load', async () => {
    area.data.set(STORAGE_KEYS.settings, { segmentConcurrency: 999, outputFormat: 42 });
    const loaded = await store.load();
    expect(loaded.segmentConcurrency).toBe(16);
    expect(loaded.outputFormat).toBe('auto');
  });

  it('initialize persists a complete, normalised object', async () => {
    area.data.set(STORAGE_KEYS.settings, { segmentConcurrency: 4, obsolete: true });
    await store.initialize();
    expect(area.data.get(STORAGE_KEYS.settings)).toEqual({ ...DEFAULT_SETTINGS, segmentConcurrency: 4 });
  });

  it('applies partial updates and keeps other fields', async () => {
    await store.update({ outputFormat: 'mkv' });
    const next = await store.update({ segmentConcurrency: 10 });
    expect(next).toEqual({ ...DEFAULT_SETTINGS, outputFormat: 'mkv', segmentConcurrency: 10 });
    await expect(store.load()).resolves.toEqual(next);
  });

  it('keeps the current value when a patch value is invalid', async () => {
    await store.update({ segmentConcurrency: 3 });
    const next = await store.update({ segmentConcurrency: Number.NaN });
    expect(next.segmentConcurrency).toBe(3);
  });

  it('serialises concurrent updates so none is lost', async () => {
    await Promise.all([
      store.update({ segmentConcurrency: 9 }),
      store.update({ autoDetect: false }),
      store.update({ preferredResolution: '1080' }),
    ]);
    await expect(store.load()).resolves.toEqual({
      ...DEFAULT_SETTINGS,
      segmentConcurrency: 9,
      autoDetect: false,
      preferredResolution: '1080',
    });
  });

  it('skips the write when nothing changes', async () => {
    await store.update({ segmentConcurrency: 8 });
    const writes = area.writeCount;
    await store.update({ segmentConcurrency: 8 });
    expect(area.writeCount).toBe(writes);
  });

  it('reset restores defaults', async () => {
    await store.update({ segmentConcurrency: 2, autoDetect: false });
    await expect(store.reset()).resolves.toEqual(DEFAULT_SETTINGS);
    await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('notifies subscribers about changes in its storage area only', async () => {
    const listener = vi.fn<(settings: Settings) => void>();
    const unsubscribe = store.subscribe(listener);

    await store.update({ segmentConcurrency: 5 });
    expect(listener).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, segmentConcurrency: 5 });

    area.events.emit({ [STORAGE_KEYS.settings]: { newValue: { segmentConcurrency: 1 } } }, 'sync');
    area.events.emit({ unrelated: { newValue: 1 } }, 'local');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    await store.update({ segmentConcurrency: 6 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('wraps storage failures in a StreamGrabError and recovers for later writes', async () => {
    area.failWrites = true;
    const failed = store.update({ segmentConcurrency: 2 });
    await expect(failed).rejects.toBeInstanceOf(StreamGrabError);
    await expect(failed).rejects.toMatchObject({ code: 'STORAGE_FAILED' });

    area.failWrites = false;
    await expect(store.update({ segmentConcurrency: 4 })).resolves.toMatchObject({ segmentConcurrency: 4 });
  });
});
