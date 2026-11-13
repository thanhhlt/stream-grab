/// <reference lib="dom" />
/// <reference types="chrome" />
/**
 * Chrome Web Store screenshots and promo tile (docs/store/), from the real popup.
 *
 *   npm run build && npm run store:assets
 *
 * Starts the fixture site on 127.0.0.1 with a demo page, loads dist/ into Chrome
 * for Testing (`npm run e2e:install`) on a throwaway profile, opens the popup on
 * that page, downloads two videos and photographs the Detected, Queue and
 * Completed tabs at 2x. Each photo is then set into a 1280x800 frame with a short
 * caption; the 440x280 tile is drawn the same way. Fonts and colours follow
 * docs/DESIGN.md. The store icon comes from `npm run icons`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Browser as BrowserKind, getInstalledBrowsers } from '@puppeteer/browsers';
import puppeteer, { type Browser, type Page, TargetType } from 'puppeteer-core';
import { projectRoot, publicDir } from '../build/paths.ts';
import { createDownloadRouter, DEMO_MEDIA } from '../tests/fixtures/download-routes.ts';
import { createFixtureRouter } from '../tests/fixtures/fixture-routes.ts';
import { syntheticMedia } from '../tests/fixtures/media/synthetic-media.ts';
import { sendResponse } from '../tests/fixtures/send-response.ts';

const outDir = join(projectRoot, 'docs', 'store');
const dist = join(projectRoot, 'dist');
const SHOWCASE_HOST = 'www.example.com';
const SHOWCASE_PATH = '/showcase';
/** The demo page: a player that loads three manifests, the way a video site does. */
const SHOWCASE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Harbour at dawn · timelapse</title></head>
<body><h1>Harbour at dawn · timelapse</h1><script>
for (const path of ['/download/plain/plain.m3u8', '/download/dash/movie.mpd', '/download/subtitled/subtitled.m3u8']) fetch(path).then((r) => r.text());
</script></body></html>`;

async function startSite(): Promise<{ origin: string; close: () => void }> {
  const media = await syntheticMedia(DEMO_MEDIA);
  const route = createFixtureRouter(
    {
      manifest: (path) => readFileSync(resolve(projectRoot, 'tests/fixtures/manifests', path), 'utf8'),
      page: () => SHOWCASE_PAGE,
      downloadPage: () => SHOWCASE_PAGE,
    },
    createDownloadRouter(media, { latencyMs: 120 }),
  );
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === SHOWCASE_PATH) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(SHOWCASE_PAGE);
      return;
    }
    sendResponse(res, route(url.pathname, { referer: req.headers.referer, range: req.headers.range, ifRange: undefined }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

async function chromePath(): Promise<string> {
  const installed = await getInstalledBrowsers({ cacheDir: resolve(projectRoot, '.cache/chrome') });
  const chrome = installed.find((candidate) => candidate.browser === BrowserKind.CHROME);
  if (!chrome) throw new Error('Chrome for Testing is missing: run `npm run e2e:install` first.');
  return chrome.executablePath;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * The popup, opened as a 400x560 tab at 2x (a real popup window takes no device
 * scale override). Its `chrome.tabs.query` for the active tab answers with
 * the demo page's tab, so it shows that page as the toolbar popup would.
 */
async function openPopup(browser: Browser, page: Page): Promise<Page> {
  const workerTarget = await browser.waitForTarget((target) => target.type() === TargetType.SERVICE_WORKER && target.url().endsWith('/background/service-worker.js'));
  const worker = await workerTarget.worker();
  const tabId = await worker?.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, page.url());
  if (tabId === undefined) throw new Error('The demo page tab was not found.');
  const popup = await browser.newPage();
  await popup.setViewport({ width: 400, height: 560, deviceScaleFactor: 2 });
  await popup.evaluateOnNewDocument((tabId) => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = ((info: chrome.tabs.QueryInfo) =>
      info.active === true ? chrome.tabs.get(tabId).then((tab) => [tab]) : query(info));
  }, tabId);
  await popup.goto(`chrome-extension://${new URL(workerTarget.url()).host}/popup/index.html`);
  await popup.waitForFunction(
    () => [...document.querySelectorAll('[aria-label^="Select "]')].filter((box) => !box.getAttribute('aria-label')?.startsWith('Select all')).length >= 3,
    { timeout: 30_000 },
  );
  return popup;
}

const scheme = (popup: Page, value: 'light' | 'dark') => popup.emulateMediaFeatures([{ name: 'prefers-color-scheme', value }]);

const clickTab = (popup: Page, name: string) =>
  popup.evaluate((name) => {
    [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent?.startsWith(name))?.click();
  }, name);

async function photograph(popup: Page): Promise<string> {
  await sleep(600); // let transitions settle
  return Buffer.from(await popup.screenshot({ type: 'png' })).toString('base64');
}

async function capturePopup(): Promise<{ detected: string; queue: string; completed: string }> {
  const site = await startSite();
  const profile = mkdtempSync(join(tmpdir(), 'streamgrab-store-'));
  const downloads = join(profile, 'Downloads');
  mkdirSync(join(profile, 'Default'), { recursive: true });
  mkdirSync(downloads);
  writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }));
  const browser = await puppeteer.launch({
    executablePath: await chromePath(),
    headless: true,
    userDataDir: profile,
    enableExtensions: [dist],
    // The demo page shows as example.com (a reserved name) instead of 127.0.0.1.
    args: ['--no-first-run', '--no-default-browser-check', `--host-resolver-rules=MAP ${SHOWCASE_HOST} 127.0.0.1`],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`http://${SHOWCASE_HOST}:${new URL(site.origin).port}${SHOWCASE_PATH}`);
    await sleep(3_000);
    const popup = await openPopup(browser, page);
    await scheme(popup, 'light');
    // Two of the three picked: the selection bar shows what one click does.
    await popup.evaluate(() => {
      const boxes = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][aria-label^="Select "]')].filter(
        (box) => !box.getAttribute('aria-label')?.startsWith('Select all'),
      );
      boxes.slice(0, 2).forEach((box) => box.click());
    });
    const detected = await photograph(popup);

    await popup.evaluate(() => {
      [...document.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Download selected'))?.click();
    });
    await scheme(popup, 'dark');
    await clickTab(popup, 'Queue');
    // Photographed once the downloads are well under way (the overall percent, 30% or more).
    await popup.waitForFunction(
      () => {
        const percent = /([\d.]+)%/.exec(document.body.innerText);
        return percent !== null && Number(percent[1]) >= 30;
      },
      { timeout: 60_000, polling: 200 },
    );
    const queue = await photograph(popup);

    // Both saved: the Completed tab lists them.
    const deadline = Date.now() + 180_000;
    await clickTab(popup, 'Completed');
    for (;;) {
      await sleep(5_000);
      const saved = await popup.evaluate(() => document.querySelectorAll('[data-completed-row], li').length);
      const queued = await popup.evaluate(() => document.querySelector('[data-tab-count="queue"]')?.textContent?.trim() ?? '');
      if ((queued === '' || queued === '0') && saved >= 2) break;
      if (Date.now() > deadline) {
        await clickTab(popup, 'Queue');
        throw new Error(`The downloads did not finish within 3 minutes. Queue:\n${await popup.evaluate(() => document.body.innerText)}`);
      }
    }
    await scheme(popup, 'light');
    const completed = await photograph(popup);
    return { detected, queue, completed };
  } finally {
    await browser.close();
    site.close();
    // Chrome's child processes can hold profile files for a moment after close (EBUSY on Windows).
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

const font = readFileSync(join(publicDir, 'fonts', 'bricolage-grotesque-latin.woff2')).toString('base64');
const icon = readFileSync(join(publicDir, 'icons', 'icon-128.png')).toString('base64');
const BASE_CSS = `
@font-face { font-family: 'Bricolage Grotesque'; src: url(data:font/woff2;base64,${font}) format('woff2'); font-weight: 400 800; }
* { box-sizing: border-box; margin: 0; }
body { font-family: 'Bricolage Grotesque', system-ui, sans-serif; -webkit-font-smoothing: antialiased; }`;

interface Frame {
  file: string;
  dark: boolean;
  headline: string;
  body: string;
  shot: string;
}

function framePage({ dark, headline, body, shot }: Frame): string {
  const bg = dark ? '#171A21' : '#FFF1E6';
  const ink = dark ? '#EEF0F4' : '#1B2030';
  const muted = dark ? '#A3A9B7' : '#5B6274';
  const line = dark ? '#2F343F' : '#F2D9C4';
  return `<!doctype html><html><head><style>${BASE_CSS}
body { width: 1280px; height: 800px; background: ${bg}; color: ${ink}; display: flex; align-items: center; padding: 0 96px; gap: 72px; }
.text { flex: 1; }
.brand { display: flex; align-items: center; gap: 12px; font-size: 22px; font-weight: 800; letter-spacing: -0.02em; margin-bottom: 40px; }
.brand img { width: 40px; height: 40px; }
h1 { font-size: 52px; line-height: 1.08; font-weight: 800; letter-spacing: -0.02em; font-variation-settings: 'opsz' 96; }
p { margin-top: 24px; font-size: 21px; line-height: 1.5; color: ${muted}; max-width: 30ch; }
.shot { width: 440px; height: 616px; border-radius: 10px; border: 1px solid ${line}; box-shadow: 0 24px 60px rgba(27, 32, 48, ${dark ? 0.5 : 0.16}); overflow: hidden; flex: none; }
.shot img { width: 100%; height: 100%; display: block; }
</style></head><body>
<div class="text"><div class="brand"><img src="data:image/png;base64,${icon}" alt="">StreamGrab</div><h1>${headline}</h1><p>${body}</p></div>
<div class="shot"><img src="data:image/png;base64,${shot}" alt=""></div>
</body></html>`;
}

const TILE_PAGE = `<!doctype html><html><head><style>${BASE_CSS}
body { width: 440px; height: 280px; background: #1B2030; color: #EEF0F4; display: flex; flex-direction: column; justify-content: center; padding: 0 40px; }
.brand { display: flex; align-items: center; gap: 16px; font-size: 40px; font-weight: 800; letter-spacing: -0.02em; }
.brand img { width: 64px; height: 64px; }
p { margin-top: 20px; font-size: 18px; line-height: 1.4; color: #A3A9B7; }
b { color: #FF8A33; font-weight: 700; }
</style></head><body>
<div class="brand"><img src="data:image/png;base64,${icon}" alt="">StreamGrab</div>
<p>Save the <b>HLS, DASH and MP4</b> videos a page plays, merged right in your browser.</p>
</body></html>`;

async function render(browser: Browser, html: string, width: number, height: number, file: string): Promise<void> {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const path = join(outDir, file);
  writeFileSync(path, await page.screenshot({ type: 'png' }));
  console.log(`wrote ${path}`);
  await page.close();
}

console.log('Generating the demo media and photographing the popup (about a minute)…');
const shots = await capturePopup();
mkdirSync(outDir, { recursive: true });
const frames: Frame[] = [
  {
    file: 'screenshot-1-detected.png',
    dark: false,
    headline: 'Every video on the page, one click away',
    body: 'HLS, DASH, MP4 and WebM streams are listed as the page plays them. Pick the quality, audio and subtitles.',
    shot: shots.detected,
  },
  {
    file: 'screenshot-2-queue.png',
    dark: true,
    headline: 'Downloads keep going in the background',
    body: 'Segments in parallel, retries, resume after a restart. FFmpeg joins video and audio into one MP4 inside your browser.',
    shot: shots.queue,
  },
  {
    file: 'screenshot-3-completed.png',
    dark: false,
    headline: 'Saved to your Downloads folder',
    body: 'No server, no account, no tracking. StreamGrab collects no data.',
    shot: shots.completed,
  },
];
const browser = await puppeteer.launch({ executablePath: await chromePath(), headless: true });
try {
  for (const frame of frames) await render(browser, framePage(frame), 1280, 800, frame.file);
  await render(browser, TILE_PAGE, 440, 280, 'promo-tile-440x280.png');
} finally {
  await browser.close();
}
