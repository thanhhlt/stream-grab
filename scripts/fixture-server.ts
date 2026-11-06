/**
 * Local test site for manual checks of the unpacked extension.
 *
 *   npm run fixtures            → http://localhost:5180/
 *
 * Serves tests/manual/detection-page.html and the manifest fixtures with the
 * Content-Types real servers use (including deliberately generic ones). The
 * same routes drive tests/integration/detection-pipeline.test.ts.
 * The download demo's media is generated at startup by the bundled FFmpeg
 * (a few seconds) and served from memory.
 * Binds to 127.0.0.1 only.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { projectRoot } from '../build/paths.ts';
import { createDownloadRouter, DEMO_MEDIA } from '../tests/fixtures/download-routes.ts';
import { createFixtureRouter } from '../tests/fixtures/fixture-routes.ts';
import { syntheticFiles } from '../tests/fixtures/media/synthetic-files.ts';
import { syntheticMedia } from '../tests/fixtures/media/synthetic-media.ts';
import { createProgressiveRouter } from '../tests/fixtures/progressive-routes.ts';
import { sendResponse } from '../tests/fixtures/send-response.ts';

const port = Number(process.env['PORT'] ?? 5180);
console.log('Generating the download demo media and the progressive files with FFmpeg.wasm…');
const started = performance.now();
const media = await syntheticMedia(DEMO_MEDIA);
const files = await syntheticFiles();
console.log(`Done in ${((performance.now() - started) / 1000).toFixed(1)} s.`);
const route = createFixtureRouter(
  {
    manifest: (path) => readFileSync(resolve(projectRoot, 'tests/fixtures/manifests', path), 'utf8'),
    page: () => readFileSync(resolve(projectRoot, 'tests/manual/detection-page.html'), 'utf8'),
    downloadPage: () => readFileSync(resolve(projectRoot, 'tests/manual/download-page.html'), 'utf8'),
  },
  createDownloadRouter(media),
  createProgressiveRouter(files),
);

/** Successful segment downloads of the demo would flood the log; manifests and errors are shown. */
const quiet = (pathname: string, status: number): boolean =>
  pathname.startsWith('/download/') && status < 400 && !/\.(m3u8|mpd)$/.test(pathname);

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const response = route(url.pathname, { referer: req.headers.referer, range: req.headers.range });
  sendResponse(res, response);
  if (quiet(url.pathname, response.status)) return;
  // Who asked and with which Referer: the page's own requests are `same-origin`; the extension's
  // fetches differ, and must carry the Referer replayed by its DNR rule.
  const site = req.headers['sec-fetch-site'] ?? '-';
  const referer = req.headers.referer ?? '-';
  const range = req.headers.range ? ` range=${req.headers.range}` : '';
  console.log(
    `${req.method ?? 'GET'} ${url.pathname}${url.search} → ${response.status} ${response.contentType}` +
      `  [fetch-site=${String(site)} referer=${referer}${range}]`,
  );
}).listen(port, '127.0.0.1', () => {
  console.log(
    `StreamGrab fixtures on http://localhost:${port}/ (download demo: http://localhost:${port}/download, ` +
      `progressive MP4/WebM files: http://localhost:${port}/files)`,
  );
});
