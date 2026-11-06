import { describe, expect, it } from 'vitest';
import { isSensitivePathSegment, redactHeaders, redactText, redactUrl } from '@/shared/utils/redact';

describe('redactUrl', () => {
  it('removes every query value but keeps the keys', () => {
    expect(redactUrl('https://cdn.example.com/hls/master.m3u8?token=abc123&expires=1700000000')).toBe(
      'https://cdn.example.com/hls/master.m3u8?token=***&expires=***',
    );
  });

  it('removes credentials and fragments', () => {
    expect(redactUrl('https://user:secret@example.com/a/manifest.mpd#access_token=xyz')).toBe(
      'https://example.com/a/manifest.mpd',
    );
  });

  it('masks token-bearing path segments', () => {
    expect(redactUrl('https://cdn.example.com/hdnts=exp=1700000000~acl=%2f*~hmac=0a1b2c/video/index.m3u8')).toBe(
      'https://cdn.example.com/***/video/index.m3u8',
    );
    expect(redactUrl('https://cdn.example.com/s/eyJhbGciOiJIUzI1NiJ9abc123DEF456ghi789/playlist.m3u8')).toBe(
      'https://cdn.example.com/s/***/playlist.m3u8',
    );
  });

  it('keeps ordinary path segments and file names', () => {
    const url = 'https://media.example.org/videos/2024/my_show_s01e02_1080p_segment_00042.m4s';
    expect(redactUrl(url)).toBe(url);
  });

  it('keeps the port', () => {
    expect(redactUrl('http://localhost:8080/live/stream.m3u8?sig=1')).toBe('http://localhost:8080/live/stream.m3u8?sig=***');
  });

  it('never echoes unparseable input', () => {
    expect(redactUrl('not a url ?token=secret')).toBe('[unparseable URL]');
  });

  it('hides blob and data URL contents', () => {
    expect(redactUrl('data:text/plain,secret')).toBe('data:[redacted]');
    expect(redactUrl('blob:https://example.com/550e8400-e29b-41d4-a716-446655440000')).toBe('blob:[redacted]');
  });
});

describe('isSensitivePathSegment', () => {
  it('flags key=value and ~ separated tokens', () => {
    expect(isSensitivePathSegment('token=abc')).toBe(true);
    expect(isSensitivePathSegment('exp~123')).toBe(true);
  });

  it('flags long mixed alphanumeric runs (hashes, base64)', () => {
    expect(isSensitivePathSegment('d41d8cd98f00b204e9800998ecf8427e')).toBe(true);
  });

  it('does not flag readable names', () => {
    expect(isSensitivePathSegment('index.m3u8')).toBe(false);
    expect(isSensitivePathSegment('segment_00001.ts')).toBe(false);
    expect(isSensitivePathSegment('averyveryverylongreadablename')).toBe(false);
  });
});

describe('redactText', () => {
  it('redacts every URL embedded in a message', () => {
    expect(
      redactText('GET https://a.example/x.m3u8?t=1 failed, retrying https://b.example/y.mpd?sig=2 (attempt 2)'),
    ).toBe('GET https://a.example/x.m3u8?t=*** failed, retrying https://b.example/y.mpd?sig=*** (attempt 2)');
  });
});

describe('redactHeaders', () => {
  it('masks credentials and reduces Referer/Origin', () => {
    expect(
      redactHeaders([
        { name: 'Cookie', value: 'session=abc' },
        { name: 'Authorization', value: 'Bearer abc' },
        { name: 'X-Playback-Session-Id', value: 'abc' },
        { name: 'Referer', value: 'https://site.example/watch?v=1&auth=xyz' },
        { name: 'Accept', value: '*/*' },
        { name: 'X-Empty' },
      ]),
    ).toEqual([
      { name: 'Cookie', value: '***' },
      { name: 'Authorization', value: '***' },
      { name: 'X-Playback-Session-Id', value: '***' },
      { name: 'Referer', value: 'https://site.example/watch?v=***&auth=***' },
      { name: 'Accept', value: '*/*' },
      { name: 'X-Empty' },
    ]);
  });
});
