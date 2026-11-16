/**
 * The Chrome Web Store marquee promo tile (1400x560, optional), docs/store/promo-marquee-1400x560.png.
 * Drawn like the small tile; the right side shows the existing detected-videos screenshot.
 * Run `npm run store:assets` first (it writes that screenshot), then `node scripts/store-marquee.ts`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Browser as BrowserKind, getInstalledBrowsers } from '@puppeteer/browsers';
import puppeteer from 'puppeteer-core';
import { projectRoot, publicDir } from '../build/paths.ts';

const outDir = join(projectRoot, 'docs', 'store');
const b64 = (path: string) => readFileSync(path).toString('base64');
const font = b64(join(publicDir, 'fonts', 'bricolage-grotesque-latin.woff2'));
const icon = b64(join(publicDir, 'icons', 'icon-128.png'));
const shot = b64(join(outDir, 'screenshot-2-detected.png'));

const html = `<!doctype html><html><head><style>
@font-face { font-family: 'Bricolage Grotesque'; src: url(data:font/woff2;base64,${font}) format('woff2'); font-weight: 400 800; }
* { box-sizing: border-box; margin: 0; }
body { width: 1400px; height: 560px; background: #1B2030; color: #EEF0F4; font-family: 'Bricolage Grotesque', system-ui, sans-serif; -webkit-font-smoothing: antialiased; display: flex; align-items: center; padding: 0 96px; gap: 64px; overflow: hidden; position: relative; }
.text { flex: none; width: 600px; }
.brand { display: flex; align-items: center; gap: 22px; font-size: 76px; font-weight: 800; letter-spacing: -0.02em; }
.brand img { width: 96px; height: 96px; }
p { margin-top: 32px; font-size: 30px; line-height: 1.4; color: #A3A9B7; }
b { color: #FF8A33; font-weight: 700; }
.shot { flex: none; width: 560px; height: 350px; border-radius: 12px; border: 1px solid #3A4156; box-shadow: 0 24px 60px rgba(0,0,0,.5); overflow: hidden; }
.shot img { width: 100%; display: block; }
</style></head><body>
<div class="text"><div class="brand"><img src="data:image/png;base64,${icon}" alt="">StreamGrab</div>
<p>Save the <b>HLS, DASH and MP4</b> videos a page plays, merged right in your browser.</p></div>
<div class="shot"><img src="data:image/png;base64,${shot}" alt=""></div>
</body></html>`;

const chrome = (await getInstalledBrowsers({ cacheDir: resolve(projectRoot, '.cache/chrome') }))
  .filter((c) => c.browser === BrowserKind.CHROME)
  .sort((x, y) => y.buildId.localeCompare(x.buildId, 'en', { numeric: true }))[0];
if (!chrome) throw new Error('Chrome for Testing is missing: run `npm run e2e:install` first.');
const browser = await puppeteer.launch({ executablePath: chrome.executablePath, headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 560, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const path = join(outDir, 'promo-marquee-1400x560.png');
  writeFileSync(path, await page.screenshot({ type: 'png' }));
  console.log(`wrote ${path}`);
} finally {
  await browser.close();
}
