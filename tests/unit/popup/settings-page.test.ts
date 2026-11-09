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
