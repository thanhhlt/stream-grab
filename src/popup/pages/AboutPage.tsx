import { useEffect, useRef } from 'react';
import { EXTENSION_NAME, PROJECT_LINKS } from '@/shared/constants';
import { BUTTON } from '../components/buttons';
import { Icon } from '../components/Icon';

/** The installed version, or '' when the manifest cannot be read (a torn-down context). */
function extensionVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return '';
  }
}

const LINKS = [
  { href: PROJECT_LINKS.source, label: 'Source code', detail: 'github.com/thanhhlt/stream-grab' },
  { href: PROJECT_LINKS.issues, label: 'Report a problem', detail: 'Opens GitHub Issues' },
  { href: PROJECT_LINKS.changelog, label: "What's new", detail: 'Changes in each version' },
] as const;

/**
 * About StreamGrab, opened from the bar under every tab. It takes the tab bar's place with a Back
 * button; the Ko-fi panel is its one primary action and stays voluntary (docs/ROADMAP.md "Funding").
 */
export function AboutPage({ onBack }: { onBack: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  // A new screen: screen readers and the keyboard start at its title.
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const version = extensionVersion();

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 pb-2">
        <button type="button" aria-label="Back" title="Back" onClick={onBack} className={BUTTON.icon}>
          <Icon name="back" />
        </button>
        <h2 ref={heading} tabIndex={-1} className="text-ui font-semibold text-ink outline-none">
          About
        </h2>
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
        <div className="flex items-center gap-3 pt-3">
          <img src="../icons/icon-128.png" alt="" width={44} height={44} className="size-11 shrink-0 rounded-[12px]" />
          <div className="min-w-0">
            <p className="text-wordmark text-ink [font-variation-settings:'opsz'_30]">{EXTENSION_NAME}</p>
            <p className="text-meta text-muted tabular-nums">{version !== '' ? `Version ${version} · Chrome extension` : 'Chrome extension'}</p>
          </div>
        </div>
        <p className="mt-3 text-ink">Saves streaming videos as one file, right in your browser.</p>

        <section aria-labelledby="support-heading" className="mt-3 rounded-[14px] bg-selected p-3.5">
          <h3 id="support-heading" className="text-[15px] leading-tight font-bold text-ink">
            Keep StreamGrab free
          </h3>
          <p className="mt-1 text-meta text-ink">No ads, no paid tier, no tracking. If it saved you time, a coffee on Ko-fi helps keep it going.</p>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
            <a href={PROJECT_LINKS.donate} target="_blank" rel="noreferrer" className={BUTTON.primary}>
              <Icon name="heart" />
              Support on Ko-fi
            </a>
            <span className="text-tech text-muted">Optional. Opens ko-fi.com</span>
          </div>
        </section>

        <ul className="mt-2 divide-y divide-line">
          {LINKS.map((link) => (
            <li key={link.label}>
              <a href={link.href} target="_blank" rel="noreferrer" className="group flex items-center gap-3 rounded-field py-2">
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-ink group-hover:text-primary-text">{link.label}</span>
                  <span className="block truncate text-meta text-muted">{link.detail}</span>
                </span>
                <Icon name="external" className="size-4 text-faint group-hover:text-primary-text" />
              </a>
            </li>
          ))}
        </ul>

        <p className="mt-2 text-tech text-muted">
          Runs in your browser and collects no data. StreamGrab is free software under the{' '}
          <a href={PROJECT_LINKS.license} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">
            GPL-3.0-or-later
          </a>
          ; the bundled FFmpeg.wasm is GPL-2.0-or-later.
        </p>
      </main>
    </>
  );
}
