// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement, Fragment } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Header } from '@/popup/components/Header';
import { useTheme } from '@/popup/hooks/useTheme';
import { SettingsPage } from '@/popup/pages/SettingsPage';
import { applyTheme, readThemeMirror, resolveTheme, THEME_MIRROR_KEY, writeThemeMirror } from '@/popup/theme';
import { STORAGE_KEYS } from '@/shared/constants';
import { click, installPopupChrome, render } from '@tests/fakes/popup-dom';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** prefers-color-scheme as Chrome reports it, with change events like a real MediaQueryList. */
function fakeSystemScheme(dark: boolean) {
  const listeners = new Set<() => void>();
  const state = { dark };
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        media: query,
        get matches() {
          return query === '(prefers-color-scheme: dark)' ? state.dark : false;
        },
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      }) as unknown as MediaQueryList,
  );
  return {
    set(next: boolean) {
      state.dark = next;
      listeners.forEach((listener) => {
        listener();
      });
    },
  };
}

const root = () => document.documentElement;
const metaContent = () => document.querySelector('meta[name="color-scheme"]')?.getAttribute('content');

beforeEach(() => {
  localStorage.clear();
  delete root().dataset['theme'];
  document.head.innerHTML = '<meta name="color-scheme" content="light dark" />';
});

describe('theme helpers', () => {
  it('resolves System from the system scheme and keeps an explicit choice', () => {
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('puts the theme on <html data-theme> and the color-scheme meta tag', () => {
    applyTheme('dark');
    expect(root().dataset['theme']).toBe('dark');
    expect(metaContent()).toBe('dark');
    applyTheme('light');
    expect(root().dataset['theme']).toBe('light');
    expect(metaContent()).toBe('light');
  });

  it('keeps a localStorage copy of the setting and ignores anything else stored there', () => {
    expect(readThemeMirror()).toBe('system');
    writeThemeMirror('dark');
    expect(localStorage.getItem(THEME_MIRROR_KEY)).toBe('dark');
    expect(readThemeMirror()).toBe('dark');
    localStorage.setItem(THEME_MIRROR_KEY, 'sepia');
    expect(readThemeMirror()).toBe('system');
  });
});

describe('theme-init.js (runs in <head> before the first paint)', () => {
  const script = readFileSync(resolve(import.meta.dirname, '../../../public/popup/theme-init.js'), 'utf8');
  const run = () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the shipped classic script, run as Chrome runs it
    const theme = new Function(script) as () => void;
    theme();
  };

  it('applies an explicit choice opposite to the system', () => {
    fakeSystemScheme(true);
    localStorage.setItem(THEME_MIRROR_KEY, 'light');
    run();
    expect(root().dataset['theme']).toBe('light');
    expect(metaContent()).toBe('light');

    fakeSystemScheme(false);
    localStorage.setItem(THEME_MIRROR_KEY, 'dark');
    run();
    expect(root().dataset['theme']).toBe('dark');
    expect(metaContent()).toBe('dark');
  });

  it('follows the system for System, a missing copy or a value it does not know', () => {
    fakeSystemScheme(true);
    run();
    expect(root().dataset['theme']).toBe('dark');
    localStorage.setItem(THEME_MIRROR_KEY, 'system');
    fakeSystemScheme(false);
    run();
    expect(root().dataset['theme']).toBe('light');
    localStorage.setItem(THEME_MIRROR_KEY, 'sepia');
    fakeSystemScheme(true);
    run();
    expect(root().dataset['theme']).toBe('dark');
  });

  it('follows the system when localStorage cannot be read', () => {
    fakeSystemScheme(true);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    run();
    expect(root().dataset['theme']).toBe('dark');
  });
});

describe('theme switch: header button and Settings row (0.5.0)', () => {
  let unmount: (() => void) | undefined;
  afterEach(() => {
    act(() => unmount?.());
    document.body.innerHTML = '';
  });

  /** The header and the Settings tab, as App wires them. */
  function Popup() {
    const { theme, setTheme } = useTheme();
    return createElement(
      Fragment,
      null,
      createElement(Header, { status: { state: 'connecting' }, theme, onThemeChange: setTheme }),
      createElement(SettingsPage),
    );
  }

  const radio = (container: HTMLElement, label: string) => {
    const input = [...container.querySelectorAll<HTMLInputElement>('input[name="theme"]')].find(
      (candidate) => candidate.closest('label')?.textContent === label,
    );
    if (!input) throw new Error(`no ${label} radio`);
    return input;
  };
  const checked = (container: HTMLElement) =>
    container.querySelector<HTMLInputElement>('input[name="theme"]:checked')?.closest('label')?.textContent;

  it('toggles from the theme in effect, saves it, and Reset to defaults goes back to System', async () => {
    const system = fakeSystemScheme(false);
    const { local } = await installPopupChrome();
    const stored = () => (local.data.get(STORAGE_KEYS.settings) as { theme?: string } | undefined)?.theme;
    const view = await render(Popup, {});
    unmount = () => view.root.unmount();
    const { container } = view;

    // System, light: the button offers dark.
    expect(root().dataset['theme']).toBe('light');
    expect(checked(container)).toBe('System');
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute('aria-labelledby')).toBe('theme-label');
    expect(document.getElementById('theme-label')?.textContent).toBe('Theme');
    const button = container.querySelector('header button');
    expect(button?.getAttribute('aria-label')).toBe('Switch to dark theme');
    expect(button?.getAttribute('title')).toBe('Switch to dark theme');

    await click(container, 'Switch to dark theme');
    await act(settle);
    expect(root().dataset['theme']).toBe('dark');
    expect(stored()).toBe('dark');
    expect(localStorage.getItem(THEME_MIRROR_KEY)).toBe('dark');
    expect(checked(container)).toBe('Dark');
    expect(container.querySelector('header button')?.getAttribute('aria-label')).toBe('Switch to light theme');

    // An explicit choice ignores the system.
    act(() => {
      system.set(true);
    });
    await click(container, 'Switch to light theme');
    await act(settle);
    expect(root().dataset['theme']).toBe('light');
    expect(stored()).toBe('light');

    // System from Settings follows the system again, live.
    await act(async () => {
      radio(container, 'System').click();
      await settle();
    });
    await act(settle);
    expect(stored()).toBe('system');
    expect(root().dataset['theme']).toBe('dark');
    act(() => {
      system.set(false);
    });
    expect(root().dataset['theme']).toBe('light');
    expect(localStorage.getItem(THEME_MIRROR_KEY)).toBe('system');

    await act(async () => {
      radio(container, 'Dark').click();
      await settle();
    });
    await act(settle);
    expect(stored()).toBe('dark');
    expect(root().dataset['theme']).toBe('dark');

    await click(container, 'Reset to defaults');
    await act(settle);
    expect(stored()).toBe('system');
    expect(checked(container)).toBe('System');
    expect(root().dataset['theme']).toBe('light');
    expect(localStorage.getItem(THEME_MIRROR_KEY)).toBe('system');
  });

  it('starts from the localStorage copy, so the first render matches what theme-init.js applied', async () => {
    fakeSystemScheme(false);
    localStorage.setItem(THEME_MIRROR_KEY, 'dark');
    await installPopupChrome({ settings: { theme: 'dark' } });
    const view = await render(Popup, {});
    unmount = () => view.root.unmount();
    expect(root().dataset['theme']).toBe('dark');
    expect(view.container.querySelector('header button')?.getAttribute('aria-label')).toBe('Switch to light theme');
  });
});
