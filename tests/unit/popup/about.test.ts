// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '@/popup/App';
import { click, installPopupChrome, render } from '@tests/fakes/popup-dom';

let unmount: (() => void) | undefined;
afterEach(() => {
  act(() => unmount?.());
  document.body.innerHTML = '';
});

const links = (root: ParentNode) => Object.fromEntries([...root.querySelectorAll('a')].map((a) => [a.textContent?.trim(), a]));

describe('Support bar and About (0.8.0)', () => {
  it('shows the Ko-fi link under every tab, and About in place of the tabs until Back', async () => {
    await installPopupChrome();
    const view = await render(App, {});
    unmount = () => view.root.unmount();
    const bar = () => view.container.querySelector('footer');

    for (const name of ['Detected', 'Queue', 'Completed', 'Settings']) {
      await act(async () => {
        [...view.container.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent?.startsWith(name))?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const kofi = bar() && links(bar() as HTMLElement)['Support on Ko-fi'];
      expect(kofi?.href, name).toBe('https://ko-fi.com/s1lent91505');
      expect(kofi?.target).toBe('_blank');
      expect(kofi?.rel).toBe('noreferrer');
    }

    await click(view.container, 'About');
    expect(view.container.querySelector('[role="tablist"]')).toBeNull();
    expect(bar()).toBeNull();
    const heading = view.container.querySelector('h2');
    expect(heading?.textContent).toBe('About');
    expect(document.activeElement).toBe(heading);
    expect(view.container.textContent).toContain('Version 9.8.7');
    expect(view.container.textContent).toContain('GPL-3.0-or-later');
    const about = links(view.container);
    expect(about['Support on Ko-fi']?.href).toBe('https://ko-fi.com/s1lent91505');
    expect(about['Source code' + 'github.com/thanhhlt/stream-grab']?.href).toBe('https://github.com/thanhhlt/stream-grab');
    expect(about['Report a problem' + 'Opens GitHub Issues']?.href).toBe('https://github.com/thanhhlt/stream-grab/issues');
    expect(about["What's new" + 'Changes in each version']?.href).toBe('https://github.com/thanhhlt/stream-grab/blob/main/CHANGELOG.md');
    for (const link of Object.values(about)) {
      expect(link.target).toBe('_blank');
      expect(link.rel).toBe('noreferrer');
    }

    // Back returns to the tab that was open (Settings), with the support bar.
    await click(view.container, 'Back');
    expect(view.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Settings');
    expect(bar()).not.toBeNull();
  });
});
