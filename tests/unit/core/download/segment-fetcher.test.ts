import { describe, expect, it } from 'vitest';
import { Aes128KeyCache, hexToBytes } from '@/core/download/aes';
import { classifyFailure, SegmentContentError, SegmentFatalError, SegmentHttpError, SegmentTransferError } from '@/core/download/retry-policy';
import { documentKind, SegmentFetcher, type PartSink } from '@/core/download/segment-fetcher';
import { diskFullMessage } from '@/core/download/storage-space';
import type { FetchFunction } from '@/core/network/manifest-fetcher';
import { bodyFor, FakeMediaSite } from '@tests/fakes/media-site';

const URL_A = 'https://cdn.example.com/video/seg-1.ts';
const noKeys = new Aes128KeyCache(() => Promise.reject(new Error('no keys expected')));

function collector() {
  const parts: Uint8Array[] = [];
  const sink: PartSink = (part, data) => {
    parts[part] = data;
    return Promise.resolve();
  };
  const joined = () => {
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  };
  return { parts, sink, joined };
}

const signal = () => new AbortController().signal;

describe('SegmentFetcher', () => {
  it('writes a large body in bounded parts as it streams in (never the whole body at once)', async () => {
    const site = new FakeMediaSite().serve(URL_A, bodyFor(URL_A, 1_000_000));
    site.chunkSize = 50_000;
    const fetcher = new SegmentFetcher({ fetch: site.fetch, keys: noKeys, partSize: 200_000 });
    const out = collector();
    let largest = 0;
    const result = await fetcher.download(
      { url: URL_A },
      async (part, data) => {
        largest = Math.max(largest, data.byteLength);
        await out.sink(part, data);
      },
      signal(),
    );
    expect(result).toEqual({ bytes: 1_000_000, parts: 5 });
    expect(largest).toBeLessThanOrEqual(250_000); // part size + at most one network chunk
    expect(out.joined()).toEqual(bodyFor(URL_A, 1_000_000));
  });

  it('requests byte ranges and handles servers that ignore the Range header', async () => {
    const full = bodyFor(URL_A, 10_000);
    for (const supportsRanges of [true, false]) {
      const site = new FakeMediaSite().serve(URL_A, full);
      site.supportsRanges = supportsRanges;
      site.chunkSize = 777;
      const out = collector();
      await new SegmentFetcher({ fetch: site.fetch, keys: noKeys }).download(
        { url: URL_A, byteRange: { offset: 2500, length: 4000 } },
        out.sink,
        signal(),
      );
      expect(site.requests[0]?.range).toBe('bytes=2500-6499');
      expect(out.joined()).toEqual(full.subarray(2500, 6500));
    }
  });

  it('refuses a web page or JSON error sent with 200 instead of a segment, before storing anything', async () => {
    const page = '\uFEFF\n  <!DOCTYPE html><html><body>Please sign in</body></html>';
    const site = new FakeMediaSite().serve(URL_A, page, 'text/html').serve(`${URL_A}?json`, '{"error":"token expired"}', 'application/json');
    const fetcher = new SegmentFetcher({ fetch: site.fetch, keys: noKeys });
    const out = collector();
    const failure = await fetcher.download({ url: URL_A }, out.sink, signal()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SegmentContentError);
    expect(failure).toMatchObject({ kind: 'web page', message: 'The server sent a web page instead of video data' });
    expect(classifyFailure(failure)).toBe('retryable');
    expect(out.parts).toEqual([]);
    await expect(fetcher.download({ url: `${URL_A}?json` }, out.sink, signal())).rejects.toMatchObject({ kind: 'JSON document' });
  });

  it('tells documents from media by their first bytes, and encrypted bodies by their type only', () => {
    const bytes = (...values: number[]) => new Uint8Array(values);
    expect(documentKind(bytes(0x47, 0x40), 'text/html', false)).toBeUndefined(); // MPEG-TS, whatever the label
    expect(documentKind(bytes(0x00, 0x00, 0x00, 0x18, 0x66), null, false)).toBeUndefined(); // MP4 box
    expect(documentKind(bytes(0x1a, 0x45), null, false)).toBeUndefined(); // WebM
    expect(documentKind(bytes(0xff, 0xf1), null, false)).toBeUndefined(); // ADTS
    expect(documentKind(new TextEncoder().encode('<?xml version="1.0"?><Error>'), 'application/octet-stream', false)).toBe('web page');
    expect(documentKind(bytes(0x3c, 0x9a), 'video/mp2t', true)).toBeUndefined(); // random ciphertext
    expect(documentKind(bytes(0x9a), 'text/html; charset=utf-8', true)).toBe('web page');
    expect(documentKind(bytes(0x9a), 'application/json', true)).toBe('JSON document');
  });

  it('does not judge a byte range in the middle of a file by its first byte', async () => {
    const file = new TextEncoder().encode('G'.repeat(100) + '<'.repeat(100));
    const site = new FakeMediaSite().serve(URL_A, new Uint8Array(file));
    const fetcher = new SegmentFetcher({ fetch: site.fetch, keys: noKeys });
    const out = collector();
    await fetcher.download({ url: URL_A, byteRange: { offset: 100, length: 100 } }, out.sink, signal());
    expect(out.joined()).toEqual(file.subarray(100));
  });

  it('reports received bytes for the speed display', async () => {
    const site = new FakeMediaSite().serve(URL_A, bodyFor(URL_A, 3000));
    site.chunkSize = 1000;
    const counts: number[] = [];
    await new SegmentFetcher({ fetch: site.fetch, keys: noKeys }).download({ url: URL_A }, collector().sink, signal(), (n) =>
      counts.push(n),
    );
    expect(counts).toEqual([1000, 1000, 1000]);
  });

  it('raises HTTP errors with Retry-After', async () => {
    const site = new FakeMediaSite().failNext(URL_A, { status: 503, headers: { 'retry-after': '3' } });
    const error = await new SegmentFetcher({ fetch: site.fetch, keys: noKeys })
      .download({ url: URL_A }, collector().sink, signal())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SegmentHttpError);
    expect(error).toMatchObject({ status: 503, retryAfterMs: 3000 });
  });

  it('detects truncated and empty bodies', async () => {
    const truncated: FetchFunction = () =>
      Promise.resolve(new Response(new Uint8Array(10), { headers: { 'content-length': '100' } }));
    await expect(
      new SegmentFetcher({ fetch: truncated, keys: noKeys }).download({ url: URL_A }, collector().sink, signal()),
    ).rejects.toBeInstanceOf(SegmentTransferError);
    const empty: FetchFunction = () => Promise.resolve(new Response(new Uint8Array(0)));
    await expect(
      new SegmentFetcher({ fetch: empty, keys: noKeys }).download({ url: URL_A }, collector().sink, signal()),
    ).rejects.toBeInstanceOf(SegmentTransferError);
  });

  it('gives up on a stalled transfer', async () => {
    const stalled: FetchFunction = (_url, init) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(5));
              init.signal?.addEventListener('abort', () => {
                controller.error(new DOMException('Aborted', 'AbortError'));
              });
            },
          }),
        ),
      );
    await expect(
      new SegmentFetcher({ fetch: stalled, keys: noKeys, stallTimeoutMs: 30 }).download({ url: URL_A }, collector().sink, signal()),
    ).rejects.toMatchObject({ name: 'SegmentTransferError', message: 'No data received for too long' });
  });

  it('reports cancellation as an AbortError', async () => {
    const site = new FakeMediaSite().serve(URL_A, bodyFor(URL_A, 1000));
    site.latencyMs = 50;
    const controller = new AbortController();
    const pending = new SegmentFetcher({ fetch: site.fetch, keys: noKeys }).download({ url: URL_A }, collector().sink, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('decrypts AES-128 segments and stores the clear bytes', async () => {
    const keyBytes = Uint8Array.from({ length: 16 }, (_, i) => 255 - i);
    const iv = '0000000000000000000000000000002a';
    const plain = bodyFor(URL_A, 5000);
    const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt']);
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: hexToBytes(iv) }, cryptoKey, plain));
    const site = new FakeMediaSite().serve(URL_A, encrypted).serve('https://keys.example.com/k', keyBytes);
    site.chunkSize = 1000;
    const keys = new Aes128KeyCache(async (url) => (await site.fetch(url, {})).arrayBuffer());
    const out = collector();
    const result = await new SegmentFetcher({ fetch: site.fetch, keys }).download(
      { url: URL_A, encryption: { method: 'AES-128', keyUrl: 'https://keys.example.com/k', iv } },
      out.sink,
      signal(),
    );
    expect(result).toEqual({ bytes: 5000, parts: 1 });
    expect(out.joined()).toEqual(plain);
  });

  it('refuses SAMPLE-AES and turns a full disk into a fatal error', async () => {
    const site = new FakeMediaSite().serve(URL_A, bodyFor(URL_A, 100));
    const fetcher = new SegmentFetcher({ fetch: site.fetch, keys: noKeys });
    await expect(
      fetcher.download({ url: URL_A, encryption: { method: 'SAMPLE-AES', keyUrl: 'https://k', iv: '00' } }, collector().sink, signal()),
    ).rejects.toBeInstanceOf(SegmentFatalError);
    await expect(
      fetcher.download({ url: URL_A }, () => Promise.reject(new DOMException('full', 'QuotaExceededError')), signal()),
    ).rejects.toMatchObject({ name: 'DiskFullError', message: diskFullMessage() });
  });
});
