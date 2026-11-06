import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeAll, describe, expect, it } from 'vitest';
import { DownloadManager, EXPIRED_LINK_MESSAGE } from '@/core/download/download-manager';
import { IndexedDbSegmentStorage } from '@/core/download/download-storage';
import type { EngineReport, EngineTaskSpec } from '@/core/models/download-task';
import { ManifestFetcher, type FetchFunction } from '@/core/network/manifest-fetcher';
import { DashAdapter } from '@/core/protocols/dash/dash-adapter';
import { HlsAdapter } from '@/core/protocols/hls/hls-adapter';
import { ProtocolRegistry } from '@/core/protocols/protocol-adapter';
import { createDownloadRouter, DEMO_MEDIA, DOWNLOAD_STREAMS } from '@tests/fixtures/download-routes';
import { syntheticMedia, type Rendition, type SyntheticMedia } from '@tests/fixtures/media/synthetic-media';

/**
 * The download demo page (`npm run fixtures` → /download) promises what each
 * stream does; this runs the real engine against the same routes (shorter,
 * with the same two qualities, and without latency) to keep those promises true.
 */

const ORIGIN = 'http://localhost:5180';
const SEGMENTS = 12;
let media: SyntheticMedia;

beforeAll(async () => {
  media = await syntheticMedia({ ...DEMO_MEDIA, segmentSeconds: 2, segments: SEGMENTS, clipSeconds: 8 });
}, 60_000);

const bytesOf = (rendition: Rendition): number => rendition.segments.reduce((sum, segment) => sum + segment.length, rendition.init?.length ?? 0);

function demo(referer?: string) {
  const route = createDownloadRouter(media, { latencyMs: 0 });
  // In Chrome the Referer comes from the extension's DNR rule; here the fetch adds it.
  const fetch: FetchFunction = (url) => {
    const response = route(new URL(url).pathname, { referer }) ?? { status: 404, contentType: 'text/plain', body: 'not found' };
    return Promise.resolve(new Response(response.body, { status: response.status, headers: { 'content-type': response.contentType } }));
  };
  const reports: EngineReport[] = [];
  const manager = new DownloadManager({
    storage: new IndexedDbSegmentStorage(new IDBFactory()),
    protocols: () => {
      const fetcher = new ManifestFetcher({ fetch });
      return new ProtocolRegistry().register(new HlsAdapter({ fetcher })).register(new DashAdapter({ fetcher }));
    },
    fetchFor: () => fetch,
    freshSource: () => Promise.resolve(null),
    releaseContexts: () => Promise.resolve(),
    report: (report) => reports.push(report),
    reportIntervalMs: 0,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, maxRetryAfterMs: 2 },
  });

  /** Downloads the best quality (360p) with the English track, as the popup's defaults would. */
  return async (path: string): Promise<EngineReport | undefined> => {
    const spec: EngineTaskSpec = {
      taskId: path,
      protocol: path.endsWith('.mpd') ? 'dash' : 'hls',
      manifestUrl: ORIGIN + path,
      context: {},
      variant: { id: 'video-0' },
      audioTrackIds: ['audio-0'],
      concurrency: 4,
    };
    manager.sync([spec]);
    await manager.idle();
    return reports.filter((report) => report.taskId === path).at(-1);
  };
}

const path = (name: string): string => {
  const stream = DOWNLOAD_STREAMS.find((candidate) => candidate.path.includes(`/${name}/`));
  if (!stream) throw new Error(`no demo stream ${name}`);
  return stream.path;
};

describe('download demo streams', () => {
  it('downloads every 360p and English-audio segment of the HLS and DASH streams', async () => {
    const download = demo();
    const hls = await download(path('plain'));
    expect(hls?.outcome).toEqual({ status: 'downloaded' });
    const tsSegments = (media.ts.video['v360'] as Rendition).segments.length + media.ts.audio.segments.length;
    expect(hls?.progress).toMatchObject({
      segmentsTotal: tsSegments,
      segmentsDone: tsSegments,
      bytes: bytesOf(media.ts.video['v360'] as Rendition) + bytesOf(media.ts.audio),
    });

    const dash = await download(path('dash'));
    expect(dash?.outcome).toEqual({ status: 'downloaded' });
    const fmp4Segments = (media.fmp4.video['v360'] as Rendition).segments.length + media.fmp4.audio.segments.length + 2; // + init per track
    expect(dash?.progress).toMatchObject({
      segmentsTotal: fmp4Segments,
      segmentsDone: fmp4Segments,
      bytes: bytesOf(media.fmp4.video['v360'] as Rendition) + bytesOf(media.fmp4.audio),
    });
  });

  it('completes the flaky stream after retrying its failing segments', async () => {
    const report = await demo()(path('flaky'));
    expect(report?.outcome).toEqual({ status: 'downloaded' });
    expect(report?.progress.retries).toBe(2); // seg-5 of the video and of the audio track (each fails once)
  });

  it('serves the protected stream only with the page as Referer', async () => {
    expect((await demo(`${ORIGIN}/download`)(path('protected')))?.outcome).toEqual({ status: 'downloaded' });
    expect((await demo()(path('protected')))?.outcome).toEqual({ status: 'failed', message: EXPIRED_LINK_MESSAGE, reason: 'expired' });
  });

  it('fails the expiring stream with the expired-link message', async () => {
    const report = await demo()(path('expiring'));
    expect(report?.outcome).toEqual({ status: 'failed', message: EXPIRED_LINK_MESSAGE, reason: 'expired' });
    expect(report?.progress.segmentsDone).toBeLessThan(2 * SEGMENTS);
  });
});
