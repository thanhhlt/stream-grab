import { describe, expect, it, vi } from 'vitest';
import { ManifestFetcher, type FetchFunction } from '@/core/network/manifest-fetcher';
import dashStatic from '@tests/fixtures/manifests/dash/static-separate-av.mpd?raw';

const encoder = new TextEncoder();

/** A body delivered in chunks that records whether the reader cancelled it. */
function chunkedBody(chunks: string[]): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean; served: () => number } {
  let index = 0;
  let wasCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(encoder.encode(chunk));
    },
    cancel() {
      wasCancelled = true;
    },
  });
  return { stream, cancelled: () => wasCancelled, served: () => index };
}

function respond(body: BodyInit | null, init: ResponseInit = {}): FetchFunction {
  return vi.fn<FetchFunction>(() => Promise.resolve(new Response(body, init)));
}

describe('ManifestFetcher', () => {
  it('returns the text and sniffed protocol of a manifest', async () => {
    const fetcher = new ManifestFetcher({ fetch: respond(dashStatic) });
    const result = await fetcher.fetchManifest('https://cdn.example.com/a.mpd', {});
    expect(result).toMatchObject({ kind: 'ok', protocol: 'dash', finalUrl: 'https://cdn.example.com/a.mpd' });
  });

  it('sends cookies, follows redirects and does not cache tokenised responses', async () => {
    const fetch = respond('#EXTM3U\n#EXT-X-TARGETDURATION:4');
    await new ManifestFetcher({ fetch }).fetchManifest('https://cdn.example.com/a.m3u8', {});
    expect(fetch).toHaveBeenCalledWith(
      'https://cdn.example.com/a.m3u8',
      expect.objectContaining({ credentials: 'include', redirect: 'follow', cache: 'no-store' }),
    );
  });

  it('stops reading as soon as the first bytes show the body is not a manifest', async () => {
    const body = chunkedBody(['<!DOCTYPE html>', `<html>${'x'.repeat(5000)}`, 'never read', 'never read']);
    const fetcher = new ManifestFetcher({ fetch: respond(body.stream), sniffChars: 1024 });
    await expect(fetcher.fetchManifest('https://a.example/x.m3u8', {})).resolves.toMatchObject({ kind: 'not-manifest' });
    expect(body.cancelled()).toBe(true);
    expect(body.served()).toBeLessThan(4);
  });

  it('enforces the size cap while streaming', async () => {
    const body = chunkedBody(['#EXTM3U\n', '#'.repeat(600), '#'.repeat(600), '#'.repeat(600), '#'.repeat(600)]);
    const fetcher = new ManifestFetcher({ fetch: respond(body.stream), maxBytes: 1000 });
    await expect(fetcher.fetchManifest('https://a.example/x.m3u8', {})).resolves.toEqual({ kind: 'too-large' });
    expect(body.cancelled()).toBe(true);
  });

  it('rejects a declared Content-Length above the cap without reading', async () => {
    const fetcher = new ManifestFetcher({
      fetch: respond('#EXTM3U', { headers: { 'content-length': '999999' } }),
      maxBytes: 1000,
    });
    await expect(fetcher.fetchManifest('https://a.example/x.m3u8', {})).resolves.toEqual({ kind: 'too-large' });
  });

  it('reports HTTP errors with their status', async () => {
    const fetcher = new ManifestFetcher({ fetch: respond('Forbidden', { status: 403 }) });
    await expect(fetcher.fetchManifest('https://a.example/x.m3u8', {})).resolves.toEqual({
      kind: 'http-error',
      status: 403,
    });
  });

  it('times out on unresponsive servers', async () => {
    const fetch: FetchFunction = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    const fetcher = new ManifestFetcher({ fetch, timeoutMs: 20 });
    await expect(fetcher.fetchManifest('https://a.example/x.m3u8', {})).resolves.toEqual({ kind: 'timeout' });
  });

  it('redacts URLs in network error messages', async () => {
    const fetch: FetchFunction = () => Promise.reject(new TypeError('Failed to fetch https://a.example/x.m3u8?token=secret'));
    const result = await new ManifestFetcher({ fetch }).fetchManifest('https://a.example/x.m3u8?token=secret', {});
    expect(result).toEqual({ kind: 'network-error', message: 'Failed to fetch https://a.example/x.m3u8?token=***' });
  });

  it('applies the request context for the duration of the request and always releases it', async () => {
    const events: string[] = [];
    const acquireContext = vi.fn((url: string) => {
      events.push(`acquire ${url}`);
      return Promise.resolve(() => {
        events.push('release');
        return Promise.resolve();
      });
    });
    const fetch: FetchFunction = (url) => {
      events.push(`fetch ${url}`);
      return Promise.reject(new TypeError('Failed to fetch'));
    };
    const context = { referer: 'https://site.example/watch' };
    await new ManifestFetcher({ fetch, acquireContext }).fetchManifest('https://cdn.example/a.m3u8', context);
    expect(acquireContext).toHaveBeenCalledWith('https://cdn.example/a.m3u8', context);
    expect(events).toEqual(['acquire https://cdn.example/a.m3u8', 'fetch https://cdn.example/a.m3u8', 'release']);
  });
});
