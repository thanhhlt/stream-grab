import { act, createElement, type FunctionComponent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { STORAGE_KEYS } from '@/shared/constants';
import { FakeStorageArea, FakeStorageEvents } from './fake-storage';

// One set of storage areas for the whole file: the popup's settings store is a module singleton bound to the first one.
const events = new FakeStorageEvents();
const local = new FakeStorageArea('local', events);
const session = new FakeStorageArea('session', events);

/**
 * The chrome.* surface the popup uses, for component tests in happy-dom:
 * storage (with change events), runtime messaging (recorded, answered ok),
 * and the downloads calls of the Completed tab.
 */
export async function installPopupChrome(
  options: {
    settings?: Record<string, unknown>;
    missingDownloads?: number[];
    /** Tab chrome.tabs.query trả về (tab Detected). */
    activeTab?: { id: number; url: string };
    /** Dữ liệu trả lời theo loại message (mặc định {}). */
    answers?: Record<string, unknown>;
  } = {},
) {
  local.data.clear();
  session.data.clear();
  // Through set(): a settings store created by an earlier test hears the change.
  await local.set({ [STORAGE_KEYS.settings]: options.settings ?? {} });
  const sent: { type: string; payload: unknown }[] = [];
  const shown: number[] = [];
  const chromeStub = {
    runtime: {
      id: 'test',
      getURL: (path: string) => `chrome-extension://test/${path}`,
      sendMessage: (envelope: { type: string; payload: unknown }) => {
        sent.push({ type: envelope.type, payload: envelope.payload });
        return Promise.resolve({ ok: true, data: options.answers?.[envelope.type] ?? {} });
      },
    },
    storage: { local, session, onChanged: events },
    tabs: { query: () => Promise.resolve(options.activeTab ? [options.activeTab] : []) },
    downloads: {
      search: ({ id }: { id: number }) => Promise.resolve([{ id, exists: !(options.missingDownloads ?? []).includes(id) }]),
      show: (id: number) => {
        shown.push(id);
      },
    },
  };
  (globalThis as Record<string, unknown>)['chrome'] = chromeStub;
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { estimate: () => Promise.resolve({ usage: 50 * 1024 ** 2, quota: 100 * 1024 ** 3 }) },
  });
  return { sent, shown, local, session };
}

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

/** Renders a component and lets its effects (storage reads) settle. */
export async function render<P extends object>(component: FunctionComponent<P>, props: P): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(component, props));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { container, root };
}

/** Clicks the button with this accessible name (aria-label or text). */
export async function click(container: HTMLElement, name: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent ?? '').trim() === name);
  if (!button) throw new Error(`no button "${name}"`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
