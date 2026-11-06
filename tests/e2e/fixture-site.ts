import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createDownloadRouter, DEMO_MEDIA } from '@tests/fixtures/download-routes';
import { createFixtureRouter } from '@tests/fixtures/fixture-routes';
import { syntheticFiles } from '@tests/fixtures/media/synthetic-files';
import { syntheticMedia } from '@tests/fixtures/media/synthetic-media';
import { createProgressiveRouter } from '@tests/fixtures/progressive-routes';
import { sendResponse } from '@tests/fixtures/send-response';

const fixtures = resolve(import.meta.dirname, '..');

export interface FixtureSite {
  /** http://127.0.0.1:<port> */
  origin: string;
  /** Paths requested, in order, with the Referer (and Range) each request carried. */
  requests: { path: string; referer: string | undefined; range?: string | undefined }[];
  close(): Promise<void>;
}

/**
 * The fixture site of `npm run fixtures` (detection page, download demo with
 * real synthetic media), on a free port of 127.0.0.1.
 */
export async function startFixtureSite(options: { latencyMs: number }): Promise<FixtureSite> {
  const media = await syntheticMedia(DEMO_MEDIA);
  const route = createFixtureRouter(
    {
      manifest: (path) => readFileSync(resolve(fixtures, 'fixtures/manifests', path), 'utf8'),
      page: () => readFileSync(resolve(fixtures, 'manual/detection-page.html'), 'utf8'),
      downloadPage: () => readFileSync(resolve(fixtures, 'manual/download-page.html'), 'utf8'),
    },
    createDownloadRouter(media, { latencyMs: options.latencyMs }),
    createProgressiveRouter(await syntheticFiles()),
  );
  const requests: FixtureSite['requests'] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({ path: url.pathname, referer: req.headers.referer, range: req.headers.range });
    sendResponse(res, route(url.pathname, { referer: req.headers.referer, range: req.headers.range }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => {
          done();
        });
      }),
  };
}
