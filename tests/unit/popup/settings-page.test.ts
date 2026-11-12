// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsPage } from '@/popup/pages/SettingsPage';
import { STORAGE_KEYS } from '@/shared/constants';
import { click, installPopupChrome, render } from '@tests/fakes/popup-dom';

let unmount: (() => void) | undefined;
afterEach(() => {
  act(() => unmount?.());
  document.body.innerHTML = '';
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
  });
}

async function key(input: HTMLInputElement, name: string): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
    await settle();
  });
}

describe('Settings: subfolder of Downloads (0.4.0)', () => {
  it('saves the folder in the form Chrome accepts, and refuses one outside Downloads', async () => {
    const { local } = await installPopupChrome();
    const view = await render(SettingsPage, {});
    unmount = () => view.root.unmount();
    const input = view.container.querySelector<HTMLInputElement>('#download-folder');
    if (!input) throw new Error('no folder field');
    const stored = () => (local.data.get(STORAGE_KEYS.settings) as { downloadFolder?: string } | undefined)?.downloadFolder ?? '';
    expect(input.value).toBe('');
    expect(view.container.textContent).toContain('Saving to: Downloads');

    await type(input, '../Desktop');
    await key(input, 'Enter');
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('".." is not allowed');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(stored()).toBe('');

    await type(input, ' Videos\\StreamGrab: 2026 ');
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    await key(input, 'Enter');
    expect(stored()).toBe('Videos/StreamGrab 2026');
    expect(input.value).toBe('Videos/StreamGrab 2026');
    expect(view.container.textContent).toContain('Saving to: Downloads/Videos/StreamGrab 2026');

    // Escape drops an unsaved edit; Reset to defaults empties the field.
    await type(input, 'Other');
    await key(input, 'Escape');
    expect(input.value).toBe('Videos/StreamGrab 2026');
    await click(view.container, 'Reset to defaults');
    await act(settle);
    expect(stored()).toBe('');
    expect(input.value).toBe('');
  });
});

describe('Settings: subtitles (0.7.0)', () => {
  it('saves the languages as tags and names them, and where subtitles go and their format', async () => {
    const { local } = await installPopupChrome();
    const view = await render(SettingsPage, {});
    unmount = () => view.root.unmount();
    const input = view.container.querySelector<HTMLInputElement>('#subtitle-languages');
    if (!input) throw new Error('no languages field');
    const stored = () => local.data.get(STORAGE_KEYS.settings) as { subtitleLanguages?: string; subtitleMode?: string; subtitleFormat?: string } | undefined;
    expect(input.value).toBe('');
    expect(view.container.textContent).toContain('No subtitles preselected');

    await type(input, 'nothing here!');
    await key(input, 'Enter');
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('No language code found');
    expect(stored()?.subtitleLanguages ?? '').toBe('');

    await type(input, 'VI; pt-br en');
    await key(input, 'Enter');
    expect(stored()?.subtitleLanguages).toBe('vi, pt-BR, en');
    expect(input.value).toBe('vi, pt-BR, en');
    expect(view.container.textContent).toContain('Preselects: Vietnamese, Brazilian Portuguese, English');

    const radio = (name: string, value: string) => view.container.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
    expect(radio('subtitle-mode', 'file')?.checked).toBe(true);
    expect(radio('subtitle-format', 'srt')?.checked).toBe(true);
    expect(radio('subtitle-mode', 'embed')?.parentElement?.textContent).toBe('In video');
    await act(async () => {
      radio('subtitle-mode', 'both')?.click();
      radio('subtitle-format', 'vtt')?.click();
      await settle();
    });
    expect(stored()).toMatchObject({ subtitleMode: 'both', subtitleFormat: 'vtt' });

    await click(view.container, 'Reset to defaults');
    await act(settle);
    expect(stored()).toMatchObject({ subtitleLanguages: '', subtitleMode: 'file', subtitleFormat: 'srt' });
    expect(input.value).toBe('');
  });
});
