import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Browser as BrowserKind, getInstalledBrowsers } from '@puppeteer/browsers';
import puppeteer, { TargetType, type Browser, type Page, type Target } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergeStoredTasks } from '@/core/download/task-store';
import { defaultAudioTracks } from '@/core/download/variant-choice';
import { probeJob, parseProbeOutput } from '@/core/media/probe';
import type { DetectedStream } from '@/core/models/detected-stream';
import type { DownloadTask } from '@/core/models/download-task';
import { STORAGE_KEYS } from '@/shared/constants';
import { NodeFfmpegRunner } from '@tests/fakes/ffmpeg-node';
import { DEMO_MEDIA } from '@tests/fixtures/download-routes';
import { startFixtureSite, type FixtureSite } from './fixture-site';

/**
 * The extension as users run it: dist/ loaded unpacked into Chrome for
 * Testing (branded Chrome ignores --load-extension), headless, with its own
 * profile and Downloads folder. Real service worker, webRequest detection,
 * declarativeNetRequest Referer rules, offscreen document, FFmpeg worker,
 * chrome.downloads and the extension's IndexedDB; the popup's requests are
 * sent from an extension page the way the popup sends them.
 *
 * Prerequisites: `npm run build` and `npm run e2e:install` (downloads Chrome
 * for Testing into .cache/chrome). Run with `npm run test:e2e`.
 */

const root = resolve(import.meta.dirname, '../..');
const dist = resolve(root, 'dist');
const DEMO_SECONDS = DEMO_MEDIA.segments * DEMO_MEDIA.segmentSeconds;

let browser: Browser;
let site: FixtureSite;
let profile: string;
let extensionId: string;
const ffmpeg = new NodeFfmpegRunner();

async function chromePath(): Promise<string> {
  const installed = await getInstalledBrowsers({ cacheDir: resolve(root, '.cache/chrome') });
  const chrome = installed.find((candidate) => candidate.browser === BrowserKind.CHROME);
  if (!chrome) throw new Error('Chrome for Testing is missing: run `npm run e2e:install` first.');
  return chrome.executablePath;
}

async function serviceWorker(): Promise<Target> {
  return browser.waitForTarget((target) => target.type() === TargetType.SERVICE_WORKER && target.url().endsWith('/background/service-worker.js'), {
    timeout: 30_000,
  });
}

/** An extension page (the popup, opened as a tab): it may use every chrome.* API the popup has. */
async function extensionPage(): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/index.html`);
  return page;
}

/** What the popup sends: an envelope addressed to the service worker. */
async function send<T>(page: Page, type: string, payload: unknown): Promise<T> {
  const result: unknown = await page.evaluate(
    (type, payload): Promise<unknown> => chrome.runtime.sendMessage({ channel: 'streamgrab/v1', target: 'background', type, payload }),
    type,
    payload,
  );
  const answer = result as { ok: boolean; data?: T; error?: { message: string } };
  if (!answer.ok) throw new Error(`${type}: ${answer.error?.message ?? 'failed'}`);
  return answer.data as T;
}

async function tasks(page: Page): Promise<DownloadTask[]> {
  const items = await page.evaluate((keys) => chrome.storage.local.get(keys), [STORAGE_KEYS.tasks, STORAGE_KEYS.taskProgress]);
  return mergeStoredTasks(items[STORAGE_KEYS.tasks], items[STORAGE_KEYS.taskProgress]);
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

/** The detection page lists streams: waits until these manifests are inspected, in the tab showing `pageUrl`. */
async function detected(page: Page, pageUrl: string, paths: string[]): Promise<{ tabId: number; streams: DetectedStream[] }> {
  return waitFor('detected streams', async () => {
    const found = await page.evaluate(async (pageUrl) => {
      const [tab] = (await chrome.tabs.query({})).filter((candidate) => candidate.url === pageUrl);
      if (tab?.id === undefined) return undefined;
      const key = `detections:${tab.id}`;
      const stored = (await chrome.storage.session.get(key))[key] as { streams: DetectedStream[] } | undefined;
      return { tabId: tab.id, streams: stored?.streams ?? [] };
    }, pageUrl);
    if (!found) return undefined;
    const ready = paths.map((path) => found.streams.find((stream) => new URL(stream.url).pathname === path && stream.status === 'ready'));
    const streams = ready.filter((stream) => stream !== undefined);
    return streams.length === paths.length ? { tabId: found.tabId, streams } : undefined;
  });
}

/** The popup's defaults: best quality, its default audio track, a generated name. */
function request(tabId: number, stream: DetectedStream) {
  const variant = stream.media?.variants[0];
  if (!variant) throw new Error(`no qualities for ${stream.url}`);
  return { tabId, streamId: stream.id, variantId: variant.id, audioTrackIds: defaultAudioTracks(stream.protocol, variant, stream.media?.audioTracks ?? []), fileName: '' };
}

/** Reads a saved file back with FFmpeg. */
async function probeFile(path: string) {
  const bytes = readFileSync(path);
  return parseProbeOutput((await ffmpeg.run(probeJob('saved.mp4', new Blob([new Uint8Array(bytes)])))).stdout);
}

/** Starts Chrome on the test profile with dist/ loaded; the extension ID derives from the path, so it stays the same. */
async function launch(): Promise<void> {
  browser = await puppeteer.launch({
    executablePath: await chromePath(),
    headless: true,
    userDataDir: profile,
    enableExtensions: [dist],
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  extensionId = new URL((await serviceWorker()).url()).host;
}

beforeAll(async () => {
  site = await startFixtureSite({ latencyMs: 40 });
  profile = mkdtempSync(join(tmpdir(), 'streamgrab-e2e-'));
  const downloads = join(profile, 'Downloads');
  mkdirSync(join(profile, 'Default'), { recursive: true });
  mkdirSync(downloads);
  writeFileSync(
    join(profile, 'Default', 'Preferences'),
    JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true } }),
  );
  await launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
  if (profile) rmSync(profile, { recursive: true, force: true });
});

describe('StreamGrab in Chrome (Chrome for Testing, unpacked dist/)', () => {
  it('detects the demo streams, downloads, merges and saves them, including one that needs the page as Referer', async () => {
    const demo = await browser.newPage();
    await demo.goto(`${site.origin}/download`);
    const ext = await extensionPage();
    const paths = ['/download/plain/plain.m3u8', '/download/dash/movie.mpd', '/download/protected/protected.m3u8'];
    const { tabId, streams } = await detected(ext, `${site.origin}/download`, paths);
    // Five streams on the page (scenario 4), each with two qualities (scenario 5).
    expect(streams.every((stream) => stream.media?.variants.length === 2)).toBe(true);

    const started = await send<{ created: { taskId: string }[]; failed: unknown[] }>(ext, 'downloads/start', { requests: streams.map((stream) => request(tabId, stream)) });
    expect(started.failed).toEqual([]);
    const ids = started.created.map((created) => created.taskId);

    const finished = await waitFor('three saved videos', async () => {
      const list = (await tasks(ext)).filter((task) => ids.includes(task.id));
      const failed = list.find((task) => task.status === 'failed');
      if (failed) throw new Error(`${failed.source.title} failed: ${failed.statusMessage ?? ''}`);
      return list.length === 3 && list.every((task) => task.status === 'completed') ? list : undefined;
    });

    for (const task of finished) {
      const saved = task.output.saved;
      expect(saved?.path).toMatch(/\.mp4$/); // typed Blob: Chrome keeps the extension
      const probe = await probeFile(saved?.path ?? '');
      expect(probe?.streams.map((stream) => `${stream.kind}:${stream.codec}`)).toEqual(['video:h264', 'audio:aac']);
      expect(probe?.durationSec).toBeCloseTo(DEMO_SECONDS, -1);
      expect(probe?.streams[0]).toMatchObject({ width: 640, height: 360 });
    }
    // The protected stream's segments carried the page as Referer: the DNR rule did its job.
    const protectedSegments = site.requests.filter((entry) => entry.path.startsWith('/download/protected/v360/seg-'));
    expect(protectedSegments.length).toBeGreaterThan(0);
    expect(protectedSegments.every((entry) => entry.referer?.startsWith(`${site.origin}/download`))).toBe(true);
    await demo.close();
    await ext.close();
  });

  it('resumes after Chrome is closed mid-download and started again', async () => {
    const demo = await browser.newPage();
    await demo.goto(`${site.origin}/download?again`);
    const ext = await extensionPage();
    const { tabId, streams } = await detected(ext, `${site.origin}/download?again`, ['/download/plain/plain.m3u8']);
    const stream = streams[0] as DetectedStream;
    const started = await send<{ created: { taskId: string }[] }>(ext, 'downloads/start', { requests: [{ ...request(tabId, stream), fileName: 'Resumed' }] });
    const taskId = started.created[0]?.taskId ?? '';

    const before = await waitFor('a partial download', async () => {
      const task = (await tasks(ext)).find((candidate) => candidate.id === taskId);
      return task?.status === 'downloading' && (task.progress?.segmentsDone ?? 0) >= 40 ? task : undefined;
    });
    expect(before.progress?.segmentsDone).toBeLessThan(before.progress?.segmentsTotal ?? 0);

    // Chrome closes: the engine stops wherever it is. Tasks (chrome.storage.local) and segments (IndexedDB) stay on disk.
    const id = extensionId;
    await browser.close();
    await launch();
    expect(extensionId).toBe(id);
    const again = await extensionPage();

    const done = await waitFor('the resumed video', async () => {
      const task = (await tasks(again)).find((candidate) => candidate.id === taskId);
      if (task?.status === 'failed') throw new Error(task.statusMessage);
      return task?.status === 'completed' ? task : undefined;
    });
    // Segments stored before the restart were reused, not downloaded again.
    expect(done.progress?.resumedSegments).toBeGreaterThanOrEqual(30);
    expect(done.output.saved?.path).toMatch(/Resumed\.mp4$/);
    const probe = await probeFile(done.output.saved?.path ?? '');
    expect(probe?.streams.map((stream) => stream.kind)).toEqual(['video', 'audio']);
    expect(probe?.durationSec).toBeCloseTo(DEMO_SECONDS, -1);
    await again.close();
  });
});
