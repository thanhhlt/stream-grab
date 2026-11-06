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
import { formatBytes } from '@/shared/utils/bytes';
import { NodeFfmpegRunner } from '@tests/fakes/ffmpeg-node';
import { DEMO_MEDIA } from '@tests/fixtures/download-routes';
import { syntheticFiles } from '@tests/fixtures/media/synthetic-files';
import {
  MSE_SEGMENT_PATH,
  PROGRESSIVE_FILES,
  PROGRESSIVE_PAGE_PATH,
  REDIRECT_TARGET_PATH,
  SLOW_FILE_PATH,
  SLOW_FILE_TITLE,
  SLOW_PAGE_PATH,
  slowFileBytes,
} from '@tests/fixtures/progressive-routes';
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
// STREAMGRAB_EXTENSION_DIR: thư mục extension khác dist/ (vd. một file ZIP release đã giải nén) — kiểm tra đúng gói phát hành.
const dist = resolve(process.env['STREAMGRAB_EXTENSION_DIR'] ?? resolve(root, 'dist'));
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

    // Tab Completed của popup thật: dung lượng thật của file đã lưu, codec và thời lượng từ phân tích FFmpeg.
    await ext.evaluate(() => {
      [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent?.startsWith('Completed'))?.click();
    });
    const rows = await waitFor('the Completed tab', async () => {
      const texts = await ext.evaluate(() => [...document.querySelectorAll('li')].map((row) => row.textContent ?? ''));
      return texts.length === 3 ? texts : undefined;
    });
    for (const task of finished) {
      const size = formatBytes(task.output.saved?.bytes ?? 0);
      expect(rows.some((row) => row.includes(`360p · 8:00 · ${size}`) && row.includes('H.264 · AAC Stereo · MP4') && row.includes('Show in folder'))).toBe(true);
    }
    expect(await ext.evaluate(() => document.body.innerText)).toMatch(/3 videos/);
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

  it('detects progressive MP4 and WebM files played by media elements, once each, not MSE fetches (0.3.0)', async () => {
    const pageUrl = `${site.origin}${PROGRESSIVE_PAGE_PATH}`;
    const page = await browser.newPage();
    await page.goto(pageUrl);
    const ext = await extensionPage();
    const files = await syntheticFiles();
    // "Ready" for the protected file means its inspection request carried the page as Referer (DNR rule).
    const { streams } = await detected(ext, pageUrl, PROGRESSIVE_FILES.map((fixture) => fixture.path));
    const byPath = new Map(streams.map((stream) => [new URL(stream.url).pathname, stream]));

    for (const fixture of PROGRESSIVE_FILES) {
      const stream = byPath.get(fixture.path);
      expect(stream).toMatchObject({
        protocol: 'progressive',
        title: fixture.title,
        progressive: { container: fixture.container, bytes: files[fixture.file].length, acceptsRanges: true },
        media: { variants: [{ id: 'file' }] },
      });
    }
    // Chrome reported the media elements' own requests (webRequest type "media"), with the page as Referer.
    expect(byPath.get('/files/sample.mp4')?.evidence).toEqual(expect.arrayContaining(['dom', 'content-type']));
    expect(byPath.get('/files/sample.mp4')?.requestContext.referer).toBe(pageUrl);
    expect(site.requests.some((entry) => entry.path === '/files/protected.mp4' && entry.range === 'bytes=0-65535' && entry.referer === pageUrl)).toBe(
      true,
    );

    // Nothing else is listed: not the redirect target (folded), not the .mp4 the page fetched by script.
    await new Promise((done) => setTimeout(done, 1000));
    const listed = await detected(ext, pageUrl, []);
    expect(listed.streams).toEqual([]);
    const all = await ext.evaluate(async (key) => {
      const stored = (await chrome.storage.session.get(key))[key] as { streams: DetectedStream[] } | undefined;
      return (stored?.streams ?? []).map((stream) => new URL(stream.url).pathname);
    }, `detections:${listed.tabId}`);
    expect(all.sort()).toEqual(PROGRESSIVE_FILES.map((fixture) => fixture.path).sort());
    expect(site.requests.some((entry) => entry.path === MSE_SEGMENT_PATH)).toBe(true);
    expect(site.requests.some((entry) => entry.path === REDIRECT_TARGET_PATH)).toBe(true);
    await page.close();
    await ext.close();
  });

  it('downloads MP4 and WebM files byte for byte next to an HLS stream, the Referer-protected one through the engine (0.3.0)', async () => {
    const filesUrl = `${site.origin}${PROGRESSIVE_PAGE_PATH}?download`;
    const demoUrl = `${site.origin}/download?mixed`;
    const filesPage = await browser.newPage();
    await filesPage.goto(filesUrl);
    const demo = await browser.newPage();
    await demo.goto(demoUrl);
    const ext = await extensionPage();
    const files = await syntheticFiles();
    const progressive = await detected(ext, filesUrl, PROGRESSIVE_FILES.map((fixture) => fixture.path));
    const hls = await detected(ext, demoUrl, ['/download/plain/plain.m3u8']);
    const hlsStream = hls.streams[0] as DetectedStream;

    const requests = [...progressive.streams.map((stream) => request(progressive.tabId, stream)), request(hls.tabId, hlsStream)];
    const started = await send<{ created: { taskId: string; streamId: string }[]; failed: unknown[] }>(ext, 'downloads/start', { requests });
    expect(started.failed).toEqual([]);
    const ids = started.created.map((created) => created.taskId);

    const finished = await waitFor('the saved files and video', async () => {
      const list = (await tasks(ext)).filter((task) => ids.includes(task.id));
      const failed = list.find((task) => task.status === 'failed');
      if (failed) throw new Error(`${failed.source.title} failed: ${failed.statusMessage ?? ''}`);
      return list.length === ids.length && list.every((task) => task.status === 'completed') ? list : undefined;
    });

    for (const fixture of PROGRESSIVE_FILES) {
      const stream = progressive.streams.find((candidate) => new URL(candidate.url).pathname === fixture.path);
      const task = finished.find((candidate) => candidate.source.streamId === stream?.id);
      expect(task?.progressive).toMatchObject({ container: fixture.container, fetch: fixture.path === '/files/protected.mp4' ? 'extension' : 'browser' });
      const saved = task?.output.saved;
      expect(saved?.path).toMatch(new RegExp(`\\.${fixture.container}$`));
      // The original file, untouched: no remux, no FFmpeg.
      const bytes = new Uint8Array(readFileSync(saved?.path ?? ''));
      expect(bytes.length).toBe(files[fixture.file].length);
      expect(Buffer.compare(bytes, files[fixture.file])).toBe(0);
      expect(saved?.bytes).toBe(files[fixture.file].length);
      expect(task?.media).toBeUndefined();
    }
    // Chrome's own download of the protected file was refused (it cannot send the Referer); the engine's fetch carried it.
    const protectedRequests = site.requests.filter((entry) => entry.path === '/files/protected.mp4' && entry.range === undefined);
    expect(protectedRequests.some((entry) => entry.referer === undefined)).toBe(true);
    expect(protectedRequests.some((entry) => entry.referer === filesUrl)).toBe(true);
    // The HLS stream went its usual way, merged by FFmpeg, alongside.
    const video = finished.find((task) => task.source.protocol === 'hls');
    expect(video?.media?.container).toBe('mp4');
    expect((await probeFile(video?.output.saved?.path ?? ''))?.streams.map((stream) => stream.kind)).toEqual(['video', 'audio']);

    await filesPage.close();
    await demo.close();
    await ext.close();
  });

  it('cancels and retries a progressive download, and finishes it after Chrome crashes or is quit mid-download (0.3.0)', async () => {
    const pageUrl = `${site.origin}${SLOW_PAGE_PATH}`;
    const page = await browser.newPage();
    await page.goto(pageUrl);
    const ext = await extensionPage();
    const { tabId, streams } = await detected(ext, pageUrl, [SLOW_FILE_PATH]);
    const stream = streams[0] as DetectedStream;
    expect(stream.title).toBe(SLOW_FILE_TITLE);
    const started = await send<{ created: { taskId: string }[] }>(ext, 'downloads/start', { requests: [{ ...request(tabId, stream), fileName: 'Slow file' }] });
    const taskId = started.created[0]?.taskId ?? '';
    const taskIn = async (context: Page) => (await tasks(context)).find((task) => task.id === taskId);
    const downloaded = (context: Page, atLeast: number) => async () => {
      const task = await taskIn(context);
      if (task?.status === 'failed') throw new Error(task.statusMessage);
      return task?.status === 'downloading' && (task.progress?.bytes ?? 0) >= atLeast ? task : undefined;
    };

    // Chrome downloads it; the service worker reads its progress in bytes.
    await waitFor('the file downloading', downloaded(ext, 512 * 1024), 30_000);
    expect(await send(ext, 'downloads/cancel', { taskIds: [taskId] })).toEqual({ cancelled: 1 });
    expect((await taskIn(ext))?.status).toBe('cancelled');
    expect(await send(ext, 'downloads/retry', { taskIds: [taskId] })).toEqual({ retried: 1 });
    const running = await waitFor('the retried download', downloaded(ext, 1024 * 1024), 30_000);
    expect(running.progress?.percent).toBeGreaterThan(0);
    expect(running.progress?.tracks?.[0]?.declaredBytes).toBe(6 * 1024 * 1024);

    // Chrome ends abruptly (a crash, a power cut) mid-download and starts again on the same profile: the task
    // is not lost, and the file is complete and intact. (Chrome 157 fetched it again from the start here; a
    // dropped connection, by contrast, is continued with a Range request.)
    browser.process()?.kill('SIGKILL');
    await new Promise((done) => setTimeout(done, 1500));
    await launch();
    let again = await extensionPage();
    const completed = (context: Page) => async () => {
      const task = await taskIn(context);
      if (task?.status === 'failed') throw new Error(task.statusMessage);
      return task?.status === 'completed' ? task : undefined;
    };
    const done = await waitFor('the continued file', completed(again), 60_000);
    // Chrome 157 forgets the name an extension gave a download it resumes: the file takes the URL's name.
    // The task records where it really is.
    expect(done.output.saved?.path).toMatch(/(Slow file|movie)( \(\d+\))?\.mp4$/);
    const source = slowFileBytes(await syntheticFiles());
    expect(Buffer.compare(new Uint8Array(readFileSync(done.output.saved?.path ?? '')), source)).toBe(0);

    // Quitting Chrome normally cancels its running downloads (and deletes the partial file): the task says so,
    // and Retry downloads the file again.
    const newPage = await browser.newPage();
    await newPage.goto(pageUrl);
    const listed = await detected(again, pageUrl, [SLOW_FILE_PATH]);
    const restarted = await send<{ created: { taskId: string }[] }>(again, 'downloads/start', {
      requests: [{ ...request(listed.tabId, listed.streams[0] as DetectedStream), fileName: 'Slow file again' }],
    });
    const secondId = restarted.created[0]?.taskId ?? '';
    await waitFor('the second download', async () => {
      const task = (await tasks(again)).find((candidate) => candidate.id === secondId);
      return task?.status === 'downloading' && (task.progress?.bytes ?? 0) >= 512 * 1024 ? task : undefined;
    }, 30_000);
    await browser.close();
    await launch();
    again = await extensionPage();
    const failed = await waitFor('the cancelled download', async () => {
      const task = (await tasks(again)).find((candidate) => candidate.id === secondId);
      return task?.status === 'failed' ? task : undefined;
    }, 30_000);
    expect(failed.statusMessage).toMatch(/because Chrome was closed during the download/);
    await send(again, 'downloads/retry', { taskIds: [secondId] });
    const redone = await waitFor('the downloaded-again file', async () => {
      const task = (await tasks(again)).find((candidate) => candidate.id === secondId);
      if (task?.status === 'failed') throw new Error(task.statusMessage);
      return task?.status === 'completed' ? task : undefined;
    }, 60_000);
    expect(Buffer.compare(new Uint8Array(readFileSync(redone.output.saved?.path ?? '')), source)).toBe(0);
    await again.close();
  });
});
