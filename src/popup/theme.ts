import { THEMES, type Theme } from '@/shared/settings/settings';
import { isOneOf } from '@/shared/utils/guards';

/** The theme in effect: the Theme setting, or Chrome's appearance setting when it is `system`. */
export type ResolvedTheme = 'light' | 'dark';

/**
 * localStorage copy of the Theme setting. The setting (chrome.storage) stays the source of truth,
 * but it is read asynchronously; `public/popup/theme-init.js` reads this copy synchronously in
 * `<head>` so the popup never paints in the wrong theme. Keep the key in sync with that script.
 */
export const THEME_MIRROR_KEY = 'streamgrab.theme';

export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

export function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_SCHEME_QUERY).matches;
}

export function resolveTheme(theme: Theme, systemDark: boolean): ResolvedTheme {
  if (theme === 'system') return systemDark ? 'dark' : 'light';
  return theme;
}

/**
 * Puts the theme on `<html data-theme>`: styles.css reads the dark tokens and `color-scheme` from
 * it. The color-scheme meta tag follows too, for what Chrome draws before the stylesheet applies.
 */
export function applyTheme(theme: ResolvedTheme, root: HTMLElement = document.documentElement): void {
  root.dataset['theme'] = theme;
  root.ownerDocument.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
}

export function readThemeMirror(): Theme {
  try {
    const stored = localStorage.getItem(THEME_MIRROR_KEY);
    return isOneOf(stored, THEMES) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function writeThemeMirror(theme: Theme): void {
  try {
    if (localStorage.getItem(THEME_MIRROR_KEY) !== theme) localStorage.setItem(THEME_MIRROR_KEY, theme);
  } catch {
    // No localStorage: the popup still themes correctly once the settings load.
  }
}
