import { useCallback, useEffect, useState } from 'react';
import { normalizeSettings, type Settings } from '@/shared/settings/settings';
import { getSettingsStore } from '@/shared/settings/settings-store';
import { errorMessage } from '@/shared/utils/errors';

export interface UseSettingsResult {
  settings: Settings | null;
  error: string | null;
  update: (patch: Partial<Settings>) => void;
  reset: () => void;
}

/**
 * Settings bound to chrome.storage.local. Updates are applied optimistically and
 * reconciled with storage; changes made by other contexts arrive through the
 * storage change subscription.
 */
export function useSettings(): UseSettingsResult {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const store = getSettingsStore();
    let active = true;
    store.load().then(
      (loaded) => {
        if (active) setSettings(loaded);
      },
      (loadError: unknown) => {
        if (active) setError(errorMessage(loadError));
      },
    );
    const unsubscribe = store.subscribe((next) => {
      if (active) setSettings(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const recover = useCallback((writeError: unknown) => {
    setError(errorMessage(writeError));
    getSettingsStore()
      .load()
      .then(setSettings, () => undefined);
  }, []);

  const update = useCallback(
    (patch: Partial<Settings>) => {
      setError(null);
      setSettings((current) => (current ? normalizeSettings({ ...current, ...patch }, current) : current));
      getSettingsStore().update(patch).then(setSettings, recover);
    },
    [recover],
  );

  const reset = useCallback(() => {
    setError(null);
    getSettingsStore().reset().then(setSettings, recover);
  }, [recover]);

  return { settings, error, update, reset };
}
