import { describe, expect, it } from 'vitest';
import {
  dedupeKey,
  defaultReferrer,
  fileNameOf,
  parseHttpUrl,
  pathExtension,
  resolveHttpUrl,
  urlShape,
} from '@/shared/utils/url';

const ext = (url: string) => pathExtension(new URL(url));

describe('pathExtension', () => {
  it('reads the extension of the last path segment and ignores the query string', () => {
    expect(ext('https://a.example/hls/master.m3u8?token=abc.ts')).toBe('m3u8');
    expect(ext('https://a.example/x/Manifest.MPD')).toBe('mpd');
    expect(ext('https://a.example/seg/chunk-1.ts#t=3')).toBe('ts');
  });

  it('handles matrix parameters, dotfiles and missing extensions', () => {
    expect(ext('https://a.example/play.m3u8;jsessionid=XYZ')).toBe('m3u8');
    expect(ext('https://a.example/.hidden')).toBe('');
    expect(ext('https://a.example/api/playlist')).toBe('');
    expect(ext('https://a.example/dir.v2/playlist')).toBe('');
  });
});

describe('resolveHttpUrl', () => {
  const base = 'https://cdn.example.com/vod/movie/master.m3u8?token=1';

  it('resolves relative references against the playlist URL', () => {
    expect(resolveHttpUrl('video/1080p/index.m3u8', base)).toBe('https://cdn.example.com/vod/movie/video/1080p/index.m3u8');
    expect(resolveHttpUrl('../shared/360p.m3u8', base)).toBe('https://cdn.example.com/vod/shared/360p.m3u8');
    expect(resolveHttpUrl('/abs/path.m3u8', base)).toBe('https://cdn.example.com/abs/path.m3u8');
    expect(resolveHttpUrl('//other.example/x.m3u8', base)).toBe('https://other.example/x.m3u8');
  });

  it('keeps absolute URLs and rejects non-http schemes', () => {
    expect(resolveHttpUrl('https://b.example/a.m3u8?x=1', base)).toBe('https://b.example/a.m3u8?x=1');
    expect(resolveHttpUrl('skd://drm.example/key', base)).toBeNull();
    expect(resolveHttpUrl('data:text/plain,x', base)).toBeNull();
    expect(parseHttpUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('dedupeKey', () => {
  it('ignores signed-URL tokens, expiry stamps and cache busters', () => {
    const a = 'https://cdn.example.com/v/master.m3u8?id=42&token=aaa&expires=1700000000&_=111';
    const b = 'https://cdn.example.com/v/master.m3u8?expires=1800000000&token=bbb&id=42&_=222';
    expect(dedupeKey(a)).toBe(dedupeKey(b));
    expect(dedupeKey(a)).toBe('https://cdn.example.com/v/master.m3u8?id=42');
  });

  it('drops AWS/GCS/Azure signature parameters and fragments', () => {
    expect(
      dedupeKey('https://bucket.s3.amazonaws.com/a.mpd?X-Amz-Signature=x&X-Amz-Date=y&sv=2020&sig=z#frag'),
    ).toBe('https://bucket.s3.amazonaws.com/a.mpd');
  });

  it('keeps parameters that identify the resource', () => {
    expect(dedupeKey('https://a.example/play?video=1&format=hls')).not.toBe(
      dedupeKey('https://a.example/play?video=2&format=hls'),
    );
  });

  it('is insensitive to parameter order and host case', () => {
    expect(dedupeKey('https://CDN.Example.com/a.m3u8?b=2&a=1')).toBe(dedupeKey('https://cdn.example.com/a.m3u8?a=1&b=2'));
  });
});

describe('urlShape', () => {
  it('collapses digit runs so segments of one stream share a shape', () => {
    expect(urlShape('https://a.example/hls/720/seg-00001?x=1')).toBe(urlShape('https://a.example/hls/720/seg-00002?x=2'));
    expect(urlShape('https://a.example/v/1/playlist')).not.toBe(urlShape('https://a.example/v/1/other'));
  });
});

describe('defaultReferrer', () => {
  it('sends the full URL same-origin and only the origin cross-origin', () => {
    expect(defaultReferrer('https://site.example/watch?v=1#t', 'https://site.example/m.m3u8')).toBe(
      'https://site.example/watch?v=1',
    );
    expect(defaultReferrer('https://site.example/watch?v=1', 'https://cdn.example/m.m3u8')).toBe('https://site.example/');
  });

  it('sends nothing on an https → http downgrade', () => {
    expect(defaultReferrer('https://site.example/watch', 'http://cdn.example/m.m3u8')).toBeUndefined();
  });
});

describe('fileNameOf', () => {
  it('returns the decoded last segment', () => {
    expect(fileNameOf('https://a.example/My%20Show/index.m3u8?x=1')).toBe('index.m3u8');
    expect(fileNameOf('https://a.example/My%20Show.m3u8')).toBe('My Show.m3u8');
    expect(fileNameOf('not a url')).toBe('');
  });
});
