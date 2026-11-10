import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import type { Theme } from '@/shared/settings/settings';
import { getSettingsStore } from '@/shared/settings/settings-store';
import {
  applyTheme,
  DARK_SCHEME_QUERY,
  readThemeMirror,
  resolveTheme,
  systemPrefersDark,
  writeThemeMirror,
  type ResolvedTheme,
} from '../theme';

export interface UseThemeResult {
  /** The theme in effect. */
  theme: ResolvedTheme;
  /** Saves an explicit choice in the settings and applies it at once. */
  setTheme: (theme: Theme) => void;
}

/**
 * Keeps `<html data-theme>` on the Theme setting, and on Chrome's appearance setting while that is
 * System (live, through matchMedia). Starts from the localStorage copy that theme-init.js already
 * applied before the first paint, then follows the settings store, including changes made on the
 * Settings tab and Reset to defaults.
 */
export function useTheme(): UseThemeResult {
  const [choice, setChoice] = useState<Theme>(readThemeMirror);
  const systemDark = useSyncExternalStore(subscribeToSystemScheme, systemPrefersDark);

  useEffect(() => {
    const store = getSettingsStore();
    let active = true;
    store.load().then(
      (settings) => {
        if (active) setChoice(settings.theme);
      },
      () => undefined,
    );
    const unsubscribe = store.subscribe((settings) => {
      if (active) setChoice(settings.theme);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const theme = resolveTheme(choice, systemDark);

  // Before paint, so the header icon and the page colors change in the same frame.
  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    writeThemeMirror(choice);
  }, [choice]);

  const setTheme = useCallback((next: Theme) => {
    setChoice(next);
    getSettingsStore()
      .update({ theme: next })
      .then(
        (saved) => {
          setChoice(saved.theme);
        },
        () => {
          // Not saved: show the stored theme again.
          getSettingsStore()
            .load()
            .then((settings) => {
              setChoice(settings.theme);
            }, () => undefined);
        },
      );
  }, []);

  return { theme, setTheme };
}

/** Chrome's appearance setting changes while the popup is open (System follows it live). */
function subscribeToSystemScheme(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia(DARK_SCHEME_QUERY);
  query.addEventListener('change', onChange);
  return () => {
    query.removeEventListener('change', onChange);
  };
}
