import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Browser as BrowserKind, getInstalledBrowsers } from '@puppeteer/browsers';
import puppeteer, { TargetType, type Browser, type Page, type Target } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PARTIAL_DIRECTORY } from '@/core/download/partial-files';
import { mergeStoredTasks } from '@/core/download/task-store';
import { defaultAudioTracks } from '@/core/download/variant-choice';
import { MERGE_DIRECTORY } from '@/core/media/output-files';
import { probeJob, parseProbeOutput } from '@/core/media/probe';
import type { DetectedStream } from '@/core/models/detected-stream';
import type { DownloadTask } from '@/core/models/download-task';
import { STORAGE_KEYS } from '@/shared/constants';
import { formatBytes } from '@/shared/utils/bytes';
import { NodeFfmpegRunner } from '@tests/fakes/ffmpeg-node';
import { DEMO_MEDIA } from '@tests/fixtures/download-routes';
import { LIVE_PAGE_PATH, LIVE_PATH, LIVE_RELOADS, LIVE_VOD_PATH } from '@tests/fixtures/fixture-routes';
import { syntheticFiles } from '@tests/fixtures/media/synthetic-files';
import {
  MSE_SEGMENT_PATH,
  PROGRESSIVE_FILES,
  PROGRESSIVE_PAGE_PATH,
  REDIRECT_TARGET_PATH,
  SLOW_FILE_PATH,
  SLOW_FILE_TITLE,
  SLOW_PAGE_PATH,
  SLOW_PROTECTED_ETAG,
  SLOW_PROTECTED_FILE_PATH,
  SLOW_PROTECTED_PAGE_PATH,
  SLOW_PROTECTED_TITLE,
  slowFileBytes,
  slowProtectedBytes,
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

/** Files in one of the extension's OPFS directories (pages, the service worker and the offscreen document share them). */
async function opfsFiles(page: Page, directory: string): Promise<string[]> {
  return page.evaluate(async (directory) => {
    const handle = await (await navigator.storage.getDirectory()).getDirectoryHandle(directory, { create: true });
    const names: string[] = [];
    for await (const name of handle.keys()) names.push(name);
    return names;
  }, directory);
}

/** Files in the extension's OPFS merge directory. */
const mergeFiles = (page: Page): Promise<string[]> => opfsFiles(page, MERGE_DIRECTORY);

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

    // Merged files go to OPFS (0.4.0). One left by a merge cut short is deleted once the engine closes.
    await ext.evaluate(async (directory) => {
      const merges = await (await navigator.storage.getDirectory()).getDirectoryHandle(directory, { create: true });
      const writable = await (await merges.getFileHandle('orphan.k0.mp4', { create: true })).createWritable();
      await writable.write(new Uint8Array(4096));
      await writable.close();
    }, MERGE_DIRECTORY);
    // Every file the merge directory shows while the videos are merged and saved, at its largest
    // (the popup tab is in front: its timers run).
    const watching = ext.evaluate(async (directory) => {
      const seen: Record<string, number> = {};
      const until = Date.now() + 300_000;
      const flag = window as unknown as { stopWatching?: boolean };
      while (flag.stopWatching !== true && Date.now() < until) {
        const merges = await (await navigator.storage.getDirectory()).getDirectoryHandle(directory, { create: true });
        for await (const [name, entry] of merges.entries()) {
          if (entry.kind !== 'file') continue;
          // Readable while FFmpeg writes it (a snapshot); gone when deleted in between.
          const size = await entry.getFile().then((file) => file.size, () => 0);
          seen[name] = Math.max(seen[name] ?? 0, size);
        }
        await new Promise((done) => setTimeout(done, 10));
      }
      return seen;
    }, MERGE_DIRECTORY);

    const started = await send<{ created: { taskId: string }[]; failed: unknown[] }>(ext, 'downloads/start', { requests: streams.map((stream) => request(tabId, stream)) });
    expect(started.failed).toEqual([]);
    const ids = started.created.map((created) => created.taskId);

    const finished = await waitFor('three saved videos', async () => {
      const list = (await tasks(ext)).filter((task) => ids.includes(task.id));
      const failed = list.find((task) => task.status === 'failed');
      if (failed) throw new Error(`${failed.source.title} failed: ${failed.statusMessage ?? ''}`);
      return list.length === 3 && list.every((task) => task.status === 'completed') ? list : undefined;
    });

    await ext.evaluate(() => {
      (window as unknown as { stopWatching?: boolean }).stopWatching = true;
    });
    const seen = Object.entries(await watching);
    // Each video was merged into a file of its own in OPFS, named after its task: the very bytes Chrome saved…
    for (const task of finished) {
      const files = seen.filter(([name]) => new RegExp(`^${task.id}\\.[a-z0-9]+\\.mp4$`).test(name));
      expect(files.map(([, size]) => size)).toEqual([task.output.saved?.bytes]);
    }
    // …deleted once Chrome had saved its copy; the orphan went with the cleanup when the engine closed.
    await waitFor('the merged files deleted', async () => ((await mergeFiles(ext)).length === 0 ? true : undefined), 30_000);

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
  it('continues a file the engine fetches with a Range request after Chrome is killed mid-download (0.6.0)', async () => {
    const pageUrl = `${site.origin}${SLOW_PROTECTED_PAGE_PATH}`;
    const page = await browser.newPage();
    await page.goto(pageUrl);
    const ext = await extensionPage();
    const { tabId, streams } = await detected(ext, pageUrl, [SLOW_PROTECTED_FILE_PATH]);
    const stream = streams[0] as DetectedStream;
    expect(stream.title).toBe(SLOW_PROTECTED_TITLE);
    const started = await send<{ created: { taskId: string }[] }>(ext, 'downloads/start', { requests: [{ ...request(tabId, stream), fileName: 'Protected slow' }] });
    const taskId = started.created[0]?.taskId ?? '';
    const taskIn = async (context: Page) => (await tasks(context)).find((task) => task.id === taskId);

    // Chrome's own download is refused (no Referer): the engine fetches the file, writing it to disk as it comes in.
    const MiB = 1024 * 1024;
    const partway = await waitFor('the engine fetching the file', async () => {
      const task = await taskIn(ext);
      if (task?.status === 'failed') throw new Error(task.statusMessage);
      return task?.status === 'downloading' && task.progressive?.fetch === 'extension' && (task.progress?.bytes ?? 0) >= 12 * MiB ? task : undefined;
    }, 60_000);
    expect(partway.progress?.bytes).toBeLessThan(24 * MiB);
    expect((await opfsFiles(ext, PARTIAL_DIRECTORY)).sort()).toEqual([`${taskId}.json`, `${taskId}.mp4`]);

    // Chrome ends abruptly mid-download and starts again on the same profile.
    browser.process()?.kill('SIGKILL');
    await new Promise((done) => setTimeout(done, 1500));
    await launch();
    const again = await extensionPage();
    // The page's Referer went with the browser session: play the video again (the run that started meanwhile may
    // have failed for want of it; Retry then continues the file).
    const reopened = await browser.newPage();
    await reopened.goto(pageUrl);
    await detected(again, pageUrl, [SLOW_PROTECTED_FILE_PATH]);
    const settled = await waitFor('the interrupted file', async () => {
      const task = await taskIn(again);
      return task?.status === 'failed' || task?.status === 'completed' ? task : undefined;
    }, 60_000);
    if (settled.status === 'failed') expect(await send(again, 'downloads/retry', { taskIds: [taskId] })).toEqual({ retried: 1 });
    const done = await waitFor('the continued file', async () => {
      const task = await taskIn(again);
      if (task?.status === 'failed' && settled.status !== 'failed') throw new Error(task.statusMessage);
      return task?.status === 'completed' ? task : undefined;
    }, 60_000);
    expect(Buffer.compare(new Uint8Array(readFileSync(done.output.saved?.path ?? '')), slowProtectedBytes(await syntheticFiles()))).toBe(0);

    // It went on from what was on disk (whole 8 MiB write parts), with the page as Referer and the ETag as If-Range.
    // (A run that started before the page was open again asked without the Referer and was refused: the file stayed.)
    const continued = site.requests.filter((entry) => entry.path === SLOW_PROTECTED_FILE_PATH && entry.ifRange !== undefined);
    expect(continued.some((entry) => entry.referer === pageUrl)).toBe(true);
    for (const entry of continued) {
      expect(entry.ifRange).toBe(SLOW_PROTECTED_ETAG);
      const from = Number(/^bytes=(\d+)-$/.exec(entry.range ?? '')?.[1]);
      expect(from).toBeGreaterThanOrEqual(8 * MiB);
      expect(from % (8 * MiB)).toBe(0);
    }
    // Saved: the file and its record are gone from the extension's storage.
    await waitFor('the file deleted', async () => ((await opfsFiles(again, PARTIAL_DIRECTORY)).some((name) => name.startsWith(taskId)) ? undefined : true), 30_000);
    await again.close();
  });

  it('lists the VOD of a page that also plays a live channel, never the live, however often it reloads (0.4.0)', async () => {
    const pageUrl = `${site.origin}${LIVE_PAGE_PATH}`;
    const page = await browser.newPage();
    await page.goto(pageUrl);
    const ext = await extensionPage();
    await page.waitForSelector('body[data-done="true"]', { timeout: 60_000 });
    const { tabId } = await detected(ext, pageUrl, [LIVE_VOD_PATH]);
    // Inspections still under way (if any) end within moments.
    await new Promise((done) => setTimeout(done, 1_500));
    const listed = await ext.evaluate(async (key) => {
      const stored = (await chrome.storage.session.get(key))[key] as { streams: DetectedStream[] } | undefined;
      return (stored?.streams ?? []).map((stream) => new URL(stream.url).pathname);
    }, `detections:${tabId}`);
    expect(listed).toEqual([LIVE_VOD_PATH]);
    expect(await ext.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe('1');
    // The page's reloads, plus the extension's inspection of the first one (a few more at most, if reloads came in while it ran).
    const liveRequests = site.requests.filter((entry) => entry.path === LIVE_PATH).length;
    expect(liveRequests).toBeGreaterThanOrEqual(LIVE_RELOADS + 1);
    expect(liveRequests).toBeLessThanOrEqual(LIVE_RELOADS + 3);
    await page.close();
    await ext.close();
  });

  it('saves into the Downloads subfolder set in Settings, and Remove all empties the Completed tab, keeping the files (0.4.0)', async () => {
    const ext = await extensionPage();
    const clickTab = (name: string) =>
      ext.evaluate((name) => {
        [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent?.startsWith(name))?.click();
      }, name);
    const clickButton = (selector: string, text: string) =>
      ext.evaluate(
        (selector, text) => {
          const root = document.querySelector(selector);
          [...(root?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.trim() === text)?.click();
        },
        selector,
        text,
      );
    const storedFolder = () =>
      ext.evaluate(async (key) => ((await chrome.storage.local.get(key))[key] as { downloadFolder?: string } | undefined)?.downloadFolder, STORAGE_KEYS.settings);

    // The real Settings tab: a backslash path with Vietnamese letters, saved in the form Chrome accepts.
    await clickTab('Settings');
    await ext.waitForSelector('#download-folder');
    await ext.type('#download-folder', 'StreamGrab\\Phim Việt');
    await ext.keyboard.press('Enter');
    await waitFor('the saved folder', async () => ((await storedFolder()) === 'StreamGrab/Phim Việt' ? true : undefined), 10_000);
    const folder = join(profile, 'Downloads', 'StreamGrab', 'Phim Việt');

    const filesUrl = `${site.origin}${PROGRESSIVE_PAGE_PATH}?folder`;
    const demoUrl = `${site.origin}/download?folder`;
    const filesPage = await browser.newPage();
    await filesPage.goto(filesUrl);
    const demo = await browser.newPage();
    await demo.goto(demoUrl);
    const file = await detected(ext, filesUrl, ['/files/sample.webm']);
    const hls = await detected(ext, demoUrl, ['/download/plain/plain.m3u8']);
    const requests = [request(file.tabId, file.streams[0] as DetectedStream), request(hls.tabId, hls.streams[0] as DetectedStream)];
    const started = await send<{ created: { taskId: string }[]; failed: unknown[] }>(ext, 'downloads/start', { requests });
    expect(started.failed).toEqual([]);
    const ids = started.created.map((created) => created.taskId);
    const finished = await waitFor('two videos saved in the subfolder', async () => {
      const list = (await tasks(ext)).filter((task) => ids.includes(task.id));
      const failed = list.find((task) => task.status === 'failed');
      if (failed) throw new Error(`${failed.source.title} failed: ${failed.statusMessage ?? ''}`);
      return list.length === 2 && list.every((task) => task.status === 'completed') ? list : undefined;
    });
    // Chrome's own download (WebM) and a merged video (Blob from the offscreen document) alike.
    for (const task of finished) {
      expect(task.output.saved?.path.startsWith(join(folder, task.output.baseName))).toBe(true);
      expect(existsSync(task.output.saved?.path ?? '')).toBe(true);
    }

    const saved = (await tasks(ext)).filter((task) => task.status === 'completed').map((task) => task.output.saved?.path ?? '');
    expect(saved.length).toBeGreaterThanOrEqual(2);
    await clickTab('Completed');
    await waitFor('the Completed tab', async () => ((await ext.evaluate(() => document.querySelectorAll('li').length)) === saved.length ? true : undefined));
    await clickButton('main', 'Remove all');
    await ext.waitForSelector('[role="alertdialog"]');
    expect(await ext.evaluate(() => document.activeElement?.textContent)).toBe('Cancel');
    await clickButton('[role="alertdialog"]', 'Remove all');
    await waitFor('an empty Completed tab', async () =>
      (await ext.evaluate(() => document.body.innerText.includes('No completed downloads'))) ? true : undefined,
    );
    expect((await tasks(ext)).filter((task) => task.status === 'completed')).toEqual([]);
    expect(saved.every((path) => existsSync(path))).toBe(true);

    // Back to the default for whatever runs next. (The popup tab is behind the video pages: no mouse clicks,
    // whose visibility check never ends in a background tab.)
    await ext.bringToFront();
    await clickTab('Settings');
    await ext.waitForSelector('#download-folder');
    await ext.evaluate(() => {
      document.querySelector<HTMLInputElement>('#download-folder')?.select();
    });
    await ext.keyboard.press('Backspace');
    await ext.keyboard.press('Enter');
    await waitFor('the default folder', async () => ((await storedFolder()) === '' ? true : undefined), 10_000);
    await filesPage.close();
    await demo.close();
    await ext.close();
  });

  it('switches the theme from Settings and the header without scrolling the popup itself (0.5.0)', async () => {
    const ext = await extensionPage();
    await ext.setViewport({ width: 400, height: 560 });
    await ext.bringToFront();
    const now = () =>
      ext.evaluate(async (key) => ({
        theme: document.documentElement.dataset['theme'],
        stored: ((await chrome.storage.local.get(key))[key] as { theme?: string } | undefined)?.theme,
        // The popup never scrolls as a whole: only <main> does.
        rootScrollTop: document.scrollingElement?.scrollTop,
        headerTop: document.querySelector('header')?.getBoundingClientRect().top,
      }), STORAGE_KEYS.settings);
    const theme = (value: string) => waitFor(`the ${value} theme`, async () => ((await now()).stored === value ? now() : undefined), 10_000);

    await ext.evaluate(() => {
      [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent?.startsWith('Settings'))?.click();
    });
    await ext.waitForSelector('input[name="theme"]');
    await ext.evaluate(() => {
      const main = document.querySelector('main');
      if (main) main.scrollTop = main.scrollHeight;
    });
    // Real mouse clicks: they focus the hidden radio, which must sit inside its pill (it used to scroll the popup).
    const pill = (value: string) => ext.$(`label:has(> input[name="theme"][value="${value}"])`);
    const initial = await now();
    await (await pill('dark'))?.click();
    const dark = await theme('dark');
    expect(dark).toMatchObject({ theme: 'dark', rootScrollTop: 0, headerTop: 0 });
    expect(initial.rootScrollTop).toBe(0);

    await ext.click('header button[aria-label="Switch to light theme"]');
    expect(await theme('light')).toMatchObject({ theme: 'light', rootScrollTop: 0, headerTop: 0 });

    await (await pill('system'))?.click();
    expect(await theme('system')).toMatchObject({ rootScrollTop: 0, headerTop: 0 });
    await ext.close();
  });
});
