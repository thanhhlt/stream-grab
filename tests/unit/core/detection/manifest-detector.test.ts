import { describe, expect, it } from 'vitest';
import {
  classifyMimeType,
  classifyResponse,
  MAX_MANIFEST_BYTES,
  type ResponseObservation,
} from '@/core/detection/manifest-detector';

function observe(url: string, overrides: Partial<ResponseObservation> = {}): ResponseObservation {
  return { url, method: 'GET', resourceType: 'xmlhttprequest', statusCode: 200, ...overrides };
}

describe('classifyMimeType', () => {
  it('recognises HLS and DASH MIME types with parameters and any case', () => {
    expect(classifyMimeType('application/vnd.apple.mpegurl')).toBe('hls');
    expect(classifyMimeType('application/x-mpegURL; charset=UTF-8')).toBe('hls');
    expect(classifyMimeType('audio/mpegurl')).toBe('hls');
    expect(classifyMimeType('Application/Dash+XML')).toBe('dash');
  });

  it('treats generic types as undecided and media types as not manifests', () => {
    expect(classifyMimeType(undefined)).toBe('generic');
    expect(classifyMimeType('application/octet-stream')).toBe('generic');
    expect(classifyMimeType('text/plain;charset=utf-8')).toBe('generic');
    expect(classifyMimeType('video/mp2t')).toBe('other');
    expect(classifyMimeType('video/iso.segment')).toBe('other');
    expect(classifyMimeType('text/html')).toBe('other');
  });
});

describe('classifyResponse', () => {
  it('detects manifests by Content-Type even without a recognisable extension', () => {
    expect(
      classifyResponse(observe('https://api.example.com/v1/play/8f3a?auth=x', { contentType: 'application/x-mpegurl' })),
    ).toEqual({ kind: 'manifest', protocol: 'hls', evidence: 'content-type' });
    expect(classifyResponse(observe('https://api.example.com/stream/42', { contentType: 'application/dash+xml' }))).toEqual(
      { kind: 'manifest', protocol: 'dash', evidence: 'content-type' },
    );
  });

  it('detects .m3u8/.mpd URLs with query strings and tokens when the type is generic or missing', () => {
    expect(
      classifyResponse(
        observe('https://cdn.example.com/hls/master.m3u8?token=eyJhbGciOi&expires=1700000000', {
          contentType: 'application/octet-stream',
        }),
      ),
    ).toEqual({ kind: 'manifest', protocol: 'hls', evidence: 'extension' });
    expect(classifyResponse(observe('https://cdn.example.com/dash/stream.mpd?sig=1', { contentType: 'text/xml' }))).toEqual({
      kind: 'manifest',
      protocol: 'dash',
      evidence: 'extension',
    });
  });

  it('uses URL format hints (Azure Media Services, proxies)', () => {
    expect(classifyResponse(observe('https://x.streaming.media.azure.net/abc/video.ism/manifest(format=m3u8-cmaf)'))).toEqual({
      kind: 'manifest',
      protocol: 'hls',
      evidence: 'url-hint',
    });
    expect(classifyResponse(observe('https://x.streaming.media.azure.net/abc/video.ism/manifest(format=mpd-time-cmaf)'))).toEqual(
      { kind: 'manifest', protocol: 'dash', evidence: 'url-hint' },
    );
    expect(
      classifyResponse(observe('https://proxy.example.com/fetch?url=https%3A%2F%2Fcdn.example.com%2Fa.m3u8')),
    ).toMatchObject({ kind: 'manifest', protocol: 'hls' });
  });

  it('never treats segments, keys or subtitles as videos', () => {
    for (const url of [
      'https://cdn.example.com/hls/segment_00001.ts?token=1',
      'https://cdn.example.com/dash/video/seg-90000.m4s',
      'https://cdn.example.com/hls/init.mp4',
      'https://cdn.example.com/hls/master.m3u8/seg1.ts',
      'https://cdn.example.com/keys/key.key',
      'https://cdn.example.com/subs/en.vtt',
    ]) {
      expect(classifyResponse(observe(url, { contentType: 'application/octet-stream' }))).toEqual({
        kind: 'ignore',
        reason: 'segment',
      });
    }
    expect(classifyResponse(observe('https://cdn.example.com/hls/playlist/seg1', { contentType: 'video/mp2t' }))).toEqual({
      kind: 'ignore',
      reason: 'content-type',
    });
  });

  it('ignores manifest-looking URLs whose Content-Type rules them out', () => {
    expect(classifyResponse(observe('https://a.example/x.m3u8', { contentType: 'text/html' }))).toEqual({
      kind: 'ignore',
      reason: 'content-type',
    });
    expect(classifyResponse(observe('https://a.example/api/manifest', { contentType: 'application/json' }))).toEqual({
      kind: 'ignore',
      reason: 'content-type',
    });
  });

  it('asks for a content probe for extensionless URLs with manifest keywords and a generic type', () => {
    expect(
      classifyResponse(observe('https://api.example.com/video/123/playlist?session=1', { contentType: 'text/plain' })),
    ).toEqual({ kind: 'probe' });
    expect(classifyResponse(observe('https://api.example.com/hls/abc', { contentType: undefined }))).toEqual({
      kind: 'probe',
    });
  });

  it('does not probe native media requests or URLs without any hint', () => {
    expect(
      classifyResponse(observe('https://a.example/video/playlist', { resourceType: 'media', contentType: 'text/plain' })),
    ).toEqual({ kind: 'ignore', reason: 'no-signal' });
    expect(classifyResponse(observe('https://a.example/api/v1/user', { contentType: 'text/plain' }))).toEqual({
      kind: 'ignore',
      reason: 'no-signal',
    });
  });

  it('accepts 304 responses by URL and ignores failures, non-GET and other resource types', () => {
    expect(classifyResponse(observe('https://a.example/x.m3u8', { statusCode: 304 }))).toMatchObject({ kind: 'manifest' });
    expect(classifyResponse(observe('https://a.example/x.m3u8', { statusCode: 206 }))).toMatchObject({ kind: 'manifest' });
    expect(classifyResponse(observe('https://a.example/x.m3u8', { statusCode: 403 }))).toEqual({
      kind: 'ignore',
      reason: 'status',
    });
    expect(classifyResponse(observe('https://a.example/x.m3u8', { statusCode: 204 }))).toMatchObject({ kind: 'ignore' });
    expect(classifyResponse(observe('https://a.example/x.m3u8', { method: 'POST' }))).toEqual({
      kind: 'ignore',
      reason: 'method',
    });
    expect(classifyResponse(observe('https://a.example/x.m3u8', { resourceType: 'script' }))).toEqual({
      kind: 'ignore',
      reason: 'resource-type',
    });
    expect(classifyResponse(observe('blob:https://a.example/123'))).toEqual({ kind: 'ignore', reason: 'not-http' });
  });

  it('ignores responses too large to be a manifest', () => {
    expect(
      classifyResponse(observe('https://a.example/x.m3u8', { contentLength: MAX_MANIFEST_BYTES + 1 })),
    ).toEqual({ kind: 'ignore', reason: 'too-large' });
  });
});

describe('classifyResponse: progressive files (0.3.0)', () => {
  const media = (url: string, overrides: Partial<ResponseObservation> = {}) =>
    classifyResponse(observe(url, { resourceType: 'media', ...overrides }));

  it('recognises MP4 and WebM played by a media element, by Content-Type even without an extension', () => {
    expect(media('https://cdn.example/v/8f3a', { contentType: 'video/mp4', statusCode: 206 })).toEqual({
      kind: 'progressive',
      container: 'mp4',
      evidence: 'content-type',
      mimeType: 'video/mp4',
    });
    expect(media('https://cdn.example/clip', { contentType: 'Video/WebM; codecs="vp9"' })).toEqual({
      kind: 'progressive',
      container: 'webm',
      evidence: 'content-type',
      mimeType: 'video/webm',
    });
    expect(media('https://cdn.example/movie.m4v?sig=1', { contentType: 'video/x-m4v' })).toMatchObject({ container: 'mp4' });
  });

  it('uses the extension when the Content-Type is generic or missing (and for 304s)', () => {
    expect(media('https://cdn.example/files/movie.MP4?token=x', { contentType: 'application/octet-stream' })).toEqual({
      kind: 'progressive',
      container: 'mp4',
      evidence: 'extension',
      mimeType: 'application/octet-stream',
    });
    expect(media('https://cdn.example/files/clip.webm', { contentType: undefined })).toEqual({
      kind: 'progressive',
      container: 'webm',
      evidence: 'extension',
    });
    expect(media('https://cdn.example/files/clip.webm', { statusCode: 304, contentType: 'text/html' })).toMatchObject({
      kind: 'progressive',
      container: 'webm',
    });
  });

  it('is not limited by the manifest size cap', () => {
    expect(media('https://cdn.example/big.mp4', { contentType: 'video/mp4', contentLength: 4 * 1024 ** 3 })).toMatchObject({
      kind: 'progressive',
    });
  });

  it('leaves XHR/fetch media (MSE segments) ignored, as before', () => {
    expect(classifyResponse(observe('https://cdn.example/dash/video_1.mp4', { contentType: 'video/mp4' }))).toEqual({
      kind: 'ignore',
      reason: 'content-type',
    });
    expect(classifyResponse(observe('https://cdn.example/hls/init.mp4', { contentType: 'application/octet-stream' }))).toEqual({
      kind: 'ignore',
      reason: 'segment',
    });
    expect(classifyResponse(observe('https://cdn.example/x.webm', { resourceType: 'other', contentType: 'video/webm' }))).toEqual({
      kind: 'ignore',
      reason: 'content-type',
    });
  });

  it('keeps manifests played by media elements as manifests and ignores other media types', () => {
    expect(media('https://cdn.example/x.m3u8', { contentType: 'application/vnd.apple.mpegurl' })).toEqual({
      kind: 'manifest',
      protocol: 'hls',
      evidence: 'content-type',
    });
    expect(media('https://cdn.example/x.mpd', { contentType: 'application/octet-stream' })).toEqual({
      kind: 'manifest',
      protocol: 'dash',
      evidence: 'extension',
    });
    expect(media('https://cdn.example/seg-1.ts', { contentType: 'video/mp2t' })).toEqual({ kind: 'ignore', reason: 'content-type' });
    expect(media('https://cdn.example/song.mp4', { contentType: 'audio/mp4' })).toEqual({ kind: 'ignore', reason: 'content-type' });
    expect(media('https://cdn.example/clip.ogv', { contentType: 'video/ogg' })).toEqual({ kind: 'ignore', reason: 'content-type' });
    expect(media('https://cdn.example/clip.mkv', { contentType: 'application/octet-stream' })).toEqual({ kind: 'ignore', reason: 'segment' });
    expect(media('https://cdn.example/x.mp4', { statusCode: 404, contentType: 'video/mp4' })).toEqual({ kind: 'ignore', reason: 'status' });
  });
});
