import { describe, expect, it } from 'vitest';
import manifest from '@/manifest/manifest.json';
import { OFFSCREEN_DOCUMENT_PATH } from '@/shared/constants';

/**
 * Guards the extension configuration. Adding a permission should be a
 * deliberate change to this list (and to docs/ARCHITECTURE.md), not an accident.
 */
const ALLOWED_PERMISSIONS = [
  'webRequest', // observe manifest requests (non-blocking; MV3 allows observation)
  'declarativeNetRequestWithHostAccess', // set Referer/Origin on the extension's own segment requests
  'storage', // settings and task metadata
  'unlimitedStorage', // multi-GB IndexedDB segment storage without quota errors or eviction
  'offscreen', // engine host: long-running downloads, Web Workers, blob URLs
  'downloads', // save the merged file
  'notifications', // completion notification
];

describe('manifest.json', () => {
  it('is Manifest V3 with a module service worker', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toEqual({ service_worker: 'background/service-worker.js', type: 'module' });
  });

  it('requires a Chrome version with runtime.getContexts and offscreen reasons', () => {
    expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(116);
  });

  it('requests only the expected permissions', () => {
    expect([...manifest.permissions].sort()).toEqual([...ALLOWED_PERMISSIONS].sort());
    expect(manifest.permissions).not.toContain('tabs');
    expect(manifest.permissions).not.toContain('webRequestBlocking');
  });

  it('limits host access to http(s)', () => {
    expect(manifest.host_permissions).toEqual(['http://*/*', 'https://*/*']);
  });

  it('allows WebAssembly but no eval or remote code on extension pages', () => {
    const csp = manifest.content_security_policy.extension_pages;
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).not.toMatch(/'unsafe-eval'|'unsafe-inline'|https?:/);
  });

  it('exposes nothing to web pages', () => {
    expect(manifest).not.toHaveProperty('web_accessible_resources');
    expect(manifest).not.toHaveProperty('externally_connectable');
  });

  it('declares the content script for http(s) frames, except on blocked sites (0.8.0)', () => {
    expect(manifest.content_scripts).toEqual([
      {
        matches: ['http://*/*', 'https://*/*'],
        exclude_matches: ['*://*.youtube.com/*', '*://*.youtu.be/*', '*://*.youtube-nocookie.com/*', '*://*.youtubekids.com/*', '*://*.googlevideo.com/*', '*://youtube.googleapis.com/*'],
        js: ['content/content-script.js'],
        run_at: 'document_idle',
        all_frames: true,
      },
    ]);
  });

  it('uses the popup page and the offscreen path the build produces', () => {
    expect(manifest.action.default_popup).toBe('popup/index.html');
    expect(OFFSCREEN_DOCUMENT_PATH).toBe('offscreen/offscreen.html');
  });
});
