import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  contentDispositionFileName,
  contentRangeTotal,
  FILE_SNIFF_BYTES,
  inspectProgressiveFile,
  sniffMediaFile,
  topLevelBoxes,
} from '@/core/detection/file-inspector';
import type { FetchFunction } from '@/core/network/manifest-fetcher';
import { syntheticFiles, type SyntheticFiles } from '@tests/fixtures/media/synthetic-files';
import { syntheticMedia } from '@tests/fixtures/media/synthetic-media';

let files: SyntheticFiles;
let fmp4Init: Uint8Array<ArrayBuffer>;
let fmp4Segment: Uint8Array<ArrayBuffer>;
let webmInit: Uint8Array;
let webmCluster: Uint8Array;

const CLUSTER = [0x1f, 0x43, 0xb6, 0x75];

beforeAll(async () => {
  files = await syntheticFiles();
  const rendition = (await syntheticMedia()).fmp4.video['v180'];
  if (!rendition?.init || !rendition.segments[0]) throw new Error('no fMP4 fixture');
  fmp4Init = rendition.init;
  fmp4Segment = rendition.segments[0];
  // A WebM "DASH" stream is the same file cut before its first Cluster.
  const cut = files.webm.findIndex((_, at) => CLUSTER.every((byte, index) => files.webm[at + index] === byte));
  webmInit = files.webm.subarray(0, cut);
  webmCluster = files.webm.subarray(cut);
}, 60_000);

const text = (value: string) => new TextEncoder().encode(value);

function padded(bytes: Uint8Array, total: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(total);
  out.set(bytes);
  return out;
}

interface Served {
  body: Uint8Array;
  status?: number;
  headers?: Record<string, string>;
  /** Answer `Range: bytes=a-b` with 206 and Content-Range. */
  ranges?: boolean;
  /** Content-Range without the total ("bytes 0-99/*"). */
  unknownTotal?: boolean;
  /** Content-Length on full (200) responses; default true. */
  length?: boolean;
  /** URL after redirects. */
  url?: string;
  chunk?: number;
}

/** A server for one file: counts the bytes it actually streamed. */
function serve(file: Served) {
  const requests: { url: string; init: RequestInit }[] = [];
  let sent = 0;
  const fetch = vi.fn<FetchFunction>((url, init) => {
    requests.push({ url, init });
    let status = file.status ?? 200;
    let body = file.body;
    const headers = new Headers(file.headers);
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('range') ?? '');
    if (status === 200 && file.ranges && range) {
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), file.body.length - 1);
      body = file.body.subarray(start, end + 1);
      status = 206;
      headers.set('content-range', `bytes ${start}-${end}/${file.unknownTotal ? '*' : file.body.length}`);
      headers.set('content-length', String(body.length));
    } else if (file.length !== false) {
      headers.set('content-length', String(body.length));
    }
    const chunk = file.chunk ?? 16 * 1024;
    let at = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= body.length) {
          controller.close();
          return;
        }
        const part = body.slice(at, at + chunk);
        at += part.length;
        sent += part.length;
        controller.enqueue(part);
      },
    });
    const response = new Response(stream, { status, headers });
    if (file.url !== undefined) Object.defineProperty(response, 'url', { value: file.url });
    return Promise.resolve(response);
  });
  return { fetch, requests, sent: () => sent };
}

const URL_MP4 = 'https://cdn.example/videos/Big%20Buck%20Bunny.mp4?Expires=1&Signature=abc';

describe('sniffMediaFile', () => {
  it('recognises whole MP4 files: moov last, faststart, fragmented', () => {
    for (const file of [files.mp4, files.mp4FastStart, files.mp4Fragmented]) {
      expect(sniffMediaFile(file.subarray(0, FILE_SNIFF_BYTES), file.length <= FILE_SNIFF_BYTES)).toEqual({ kind: 'file', container: 'mp4' });
      // Only the start of a long file: the same answer.
      expect(sniffMediaFile(file.subarray(0, 1024), false)).toEqual({ kind: 'file', container: 'mp4' });
    }
    expect(topLevelBoxes(files.mp4)).toEqual(expect.arrayContaining(['ftyp', 'mdat', 'moov']));
    expect(topLevelBoxes(files.mp4FastStart).indexOf('moov')).toBeLessThan(topLevelBoxes(files.mp4FastStart).indexOf('mdat'));
    expect(topLevelBoxes(files.mp4Fragmented)).toEqual(expect.arrayContaining(['ftyp', 'moov', 'moof', 'mdat']));
  });

  it('recognises WebM files', () => {
    expect(sniffMediaFile(files.webm, true)).toEqual({ kind: 'file', container: 'webm' });
    expect(sniffMediaFile(files.webm.subarray(0, 256), false)).toEqual({ kind: 'file', container: 'webm' });
  });

  it('tells segments of a stream apart from files', () => {
    expect(sniffMediaFile(fmp4Segment, true)).toMatchObject({ kind: 'segment', reason: expect.stringContaining('segment') as string });
    expect(sniffMediaFile(fmp4Segment.subarray(0, 512), false)).toMatchObject({ kind: 'segment' });
    // An initialisation segment is ftyp + moov and nothing else: recognisable only when the whole file is known.
    expect(sniffMediaFile(fmp4Init, true)).toMatchObject({ kind: 'segment', reason: expect.stringContaining('initialization') as string });
    expect(sniffMediaFile(webmInit, true)).toMatchObject({ kind: 'segment', reason: expect.stringContaining('initialization') as string });
    expect(sniffMediaFile(webmCluster, true)).toMatchObject({ kind: 'segment' });
  });

  it('reports web pages and JSON as documents, and other data as unknown', () => {
    expect(sniffMediaFile(text('\n  <!DOCTYPE html><html><body>Sign in</body></html>'), true)).toMatchObject({
      kind: 'document',
      reason: expect.stringContaining('web page') as string,
    });
    expect(sniffMediaFile(text('{"error":"expired"}'), true)).toMatchObject({ kind: 'document', reason: expect.stringContaining('JSON') as string });
    expect(sniffMediaFile(new Uint8Array([0x47, 0x40, 0x00, 0x10, 0, 0, 0, 0, 0, 0]), true)).toMatchObject({ kind: 'unknown' });
    expect(sniffMediaFile(text('#EXTM3U\n'), true)).toMatchObject({ kind: 'unknown' });
    expect(sniffMediaFile(new Uint8Array(0), true)).toMatchObject({ kind: 'unknown' });
    // EBML with DocType "matroska": an MKV file, not WebM.
    const mkv = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x8b, 0x42, 0x82, 0x88, ...text('matroska'), 0x1f, 0x43, 0xb6, 0x75]);
    expect(sniffMediaFile(mkv, false)).toMatchObject({ kind: 'unknown', reason: expect.stringContaining('matroska') as string });
  });

  it('walks 64-bit box sizes and stops at malformed ones', () => {
    const large = new Uint8Array([0, 0, 0, 1, ...text('mdat'), 0, 0, 0, 1, 0, 0, 0, 0]);
    expect(topLevelBoxes(new Uint8Array([0, 0, 0, 16, ...text('ftyp'), 0, 0, 0, 0, 0, 0, 0, 0, ...large]))).toEqual(['ftyp', 'mdat']);
    expect(topLevelBoxes(new Uint8Array([0, 0, 0, 2, ...text('ftyp'), 0, 0, 0, 16, ...text('moov')]))).toEqual(['ftyp']);
  });
});

describe('header helpers', () => {
  it('reads the file name of a Content-Disposition header', () => {
    expect(contentDispositionFileName('attachment; filename="My \\"Movie\\".mp4"')).toBe('My "Movie".mp4');
    expect(contentDispositionFileName("attachment; filename=fallback.mp4; filename*=UTF-8''Phim%20hay%20t%E1%BA%ADp%201.mp4")).toBe(
      'Phim hay tập 1.mp4',
    );
    expect(contentDispositionFileName('inline; filename=clip.webm')).toBe('clip.webm');
    expect(contentDispositionFileName('attachment; filename="../../etc/clip.mp4"')).toBe('clip.mp4');
    expect(contentDispositionFileName('inline')).toBeUndefined();
    expect(contentDispositionFileName(null)).toBeUndefined();
  });

  it('reads the total size of a Content-Range header', () => {
    expect(contentRangeTotal('bytes 0-65535/734003200')).toBe(734003200);
    expect(contentRangeTotal('bytes 0-65535/*')).toBeUndefined();
    expect(contentRangeTotal('items 0-1/2')).toBeUndefined();
    expect(contentRangeTotal(null)).toBeUndefined();
  });
});

describe('inspectProgressiveFile', () => {
  it('reads only the first bytes of a ranged file and reports its size, type and name', async () => {
    const big = padded(files.mp4FastStart, 8 * 1024 * 1024);
    const server = serve({ body: big, ranges: true, headers: { 'content-type': 'video/mp4' } });
    const release = vi.fn(() => Promise.resolve());
    const acquireContext = vi.fn(() => Promise.resolve(release));
    const context = { referer: 'https://site.example/watch/1' };

    const outcome = await inspectProgressiveFile({ fetch: server.fetch, acquireContext }, URL_MP4, context);

    expect(outcome).toEqual({
      kind: 'progressive',
      finalUrl: URL_MP4,
      info: { container: 'mp4', mimeType: 'video/mp4', bytes: big.length, acceptsRanges: true, fileName: 'Big Buck Bunny.mp4' },
    });
    expect(new Headers(server.requests[0]?.init.headers).get('range')).toBe(`bytes=0-${FILE_SNIFF_BYTES - 1}`);
    expect(server.requests[0]?.init).toMatchObject({ credentials: 'include', redirect: 'follow' });
    expect(acquireContext).toHaveBeenCalledWith(URL_MP4, context);
    expect(release).toHaveBeenCalledOnce();
    expect(server.sent()).toBeLessThanOrEqual(FILE_SNIFF_BYTES);
  });

  it('does not download a whole file whose server ignores ranges, and takes its size from Content-Length', async () => {
    const big = padded(files.webm, 6 * 1024 * 1024);
    const server = serve({ body: big, headers: { 'content-type': 'video/webm' } });
    const outcome = await inspectProgressiveFile({ fetch: server.fetch }, 'https://cdn.example/a/clip.webm', {});
    expect(outcome).toMatchObject({ kind: 'progressive', info: { container: 'webm', bytes: big.length, acceptsRanges: false } });
    expect(server.sent()).toBeLessThan(FILE_SNIFF_BYTES + 3 * 16 * 1024);
  });

  it('leaves the size out when the server does not say it (chunked, compressed)', async () => {
    const big = padded(files.mp4, 1024 * 1024);
    const chunked = serve({ body: big, length: false, headers: { 'content-type': 'application/octet-stream' } });
    const compressed = serve({ body: big, headers: { 'content-type': 'video/mp4', 'content-encoding': 'gzip' } });
    const unknownTotal = serve({ body: big, ranges: true, unknownTotal: true });
    for (const server of [chunked, compressed, unknownTotal]) {
      const outcome = await inspectProgressiveFile({ fetch: server.fetch }, URL_MP4, {});
      expect(outcome.kind).toBe('progressive');
      expect(outcome.kind === 'progressive' && outcome.info.bytes).toBeUndefined();
    }
    expect(await inspectProgressiveFile({ fetch: chunked.fetch }, URL_MP4, {})).toMatchObject({
      info: { mimeType: 'application/octet-stream', acceptsRanges: false },
    });
    expect(await inspectProgressiveFile({ fetch: unknownTotal.fetch }, URL_MP4, {})).toMatchObject({ info: { acceptsRanges: true } });
  });

  it('knows the size of a small file read to its end, even without headers', async () => {
    const server = serve({ body: files.mp4, length: false });
    expect(await inspectProgressiveFile({ fetch: server.fetch }, URL_MP4, {})).toMatchObject({
      kind: 'progressive',
      info: { bytes: files.mp4.length },
    });
  });

  it('follows redirects: the final URL names the file, unless the server names it', async () => {
    const finalUrl = 'https://edge.cdn.example/store/7/f3a9/episode-07.webm?sig=xyz';
    const redirected = serve({ body: files.webm, ranges: true, url: finalUrl });
    expect(await inspectProgressiveFile({ fetch: redirected.fetch }, 'https://site.example/play/7', {})).toMatchObject({
      kind: 'progressive',
      finalUrl,
      info: { fileName: 'episode-07.webm' },
    });
    const named = serve({ body: files.webm, ranges: true, url: finalUrl, headers: { 'content-disposition': 'attachment; filename="Episode 7.webm"' } });
    expect(await inspectProgressiveFile({ fetch: named.fetch }, 'https://site.example/play/7', {})).toMatchObject({
      info: { fileName: 'Episode 7.webm' },
    });
  });

  it('trusts the bytes over the URL and the Content-Type', async () => {
    const server = serve({ body: files.webm, ranges: true, headers: { 'content-type': 'video/mp4' } });
    expect(await inspectProgressiveFile({ fetch: server.fetch }, 'https://cdn.example/clip.mp4', {})).toMatchObject({
      kind: 'progressive',
      info: { container: 'webm', mimeType: 'video/mp4' },
    });
  });

  it('drops segments and initialization segments of streams (native HLS playback)', async () => {
    for (const body of [fmp4Segment, fmp4Init, webmInit, webmCluster]) {
      const server = serve({ body, ranges: true, headers: { 'content-type': 'video/mp4' } });
      expect(await inspectProgressiveFile({ fetch: server.fetch }, 'https://cdn.example/hls/seg-1.mp4', {})).toMatchObject({
        kind: 'not-manifest',
      });
    }
  });

  it('reports HTTP errors, web pages, network errors and timeouts as failures, releasing the context', async () => {
    const release = vi.fn(() => Promise.resolve());
    const deps = (fetch: FetchFunction) => ({ fetch, acquireContext: () => Promise.resolve(release), timeoutMs: 50 });

    expect(await inspectProgressiveFile(deps(serve({ body: text('denied'), status: 403 }).fetch), URL_MP4, {})).toEqual({
      kind: 'failed',
      reason: expect.stringContaining('Access denied (HTTP 403)') as string,
    });
    expect(await inspectProgressiveFile(deps(serve({ body: text('gone'), status: 410 }).fetch), URL_MP4, {})).toEqual({
      kind: 'failed',
      reason: expect.stringContaining('Not found (HTTP 410)') as string,
    });
    const login = serve({ body: text('<!doctype html><title>Sign in</title>'), headers: { 'content-type': 'text/html' } });
    expect(await inspectProgressiveFile(deps(login.fetch), URL_MP4, {})).toEqual({
      kind: 'failed',
      reason: expect.stringContaining('web page instead of the video') as string,
    });
    const broken: FetchFunction = () => Promise.reject(new TypeError('Failed to fetch https://cdn.example/x.mp4?token=secret'));
    const failed = await inspectProgressiveFile(deps(broken), URL_MP4, {});
    expect(failed).toMatchObject({ kind: 'failed', reason: expect.stringContaining('Network error') as string });
    expect(JSON.stringify(failed)).not.toContain('secret');
    const hanging: FetchFunction = (_url, init) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    expect(await inspectProgressiveFile(deps(hanging), URL_MP4, {})).toEqual({ kind: 'failed', reason: 'The server did not respond in time.' });
    expect(release).toHaveBeenCalledTimes(5);
  });
});
