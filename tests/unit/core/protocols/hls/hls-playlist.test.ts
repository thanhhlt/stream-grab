import { describe, expect, it } from 'vitest';
import {
  HLS_LIMITS,
  parseHlsPlaylist,
  toMediaSegments,
  type ParsedMasterPlaylist,
  type ParsedMediaPlaylist,
} from '@/core/protocols/hls/hls-playlist';
import { StreamGrabError } from '@/shared/utils/errors';
import hlsMasterMuxed from '@tests/fixtures/manifests/hls/master-muxed-audio.m3u8?raw';
import hlsMaster from '@tests/fixtures/manifests/hls/master.m3u8?raw';
import hlsByteRange from '@tests/fixtures/manifests/hls/media-byterange-ts.m3u8?raw';
import hlsDiscontinuity from '@tests/fixtures/manifests/hls/media-discontinuity.m3u8?raw';
import hlsFmp4 from '@tests/fixtures/manifests/hls/media-fmp4.m3u8?raw';
import hlsLive from '@tests/fixtures/manifests/hls/media-live.m3u8?raw';
import hlsSampleAes from '@tests/fixtures/manifests/hls/media-sample-aes.m3u8?raw';
import hlsTs from '@tests/fixtures/manifests/hls/media-ts.m3u8?raw';

const MASTER_URL = 'https://cdn.example.com/vod/movie/master.m3u8?token=abc';
const MEDIA_URL = 'https://cdn.example.com/vod/movie/video/1080p/prog_index.m3u8?token=abc';
const MAIN = { id: 'main', type: 'main' } as const;

function master(text: string, url = MASTER_URL): ParsedMasterPlaylist {
  const parsed = parseHlsPlaylist(text, url);
  if (parsed.kind !== 'master') throw new Error('expected a master playlist');
  return parsed;
}

function media(text: string, url = MEDIA_URL): ParsedMediaPlaylist {
  const parsed = parseHlsPlaylist(text, url);
  if (parsed.kind !== 'media') throw new Error('expected a media playlist');
  return parsed;
}

function expectInvalid(run: () => unknown, code = 'MANIFEST_INVALID'): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(StreamGrabError);
    expect((error as StreamGrabError).code).toBe(code);
    return;
  }
  throw new Error('expected an error');
}

describe('parseHlsPlaylist: multivariant playlists', () => {
  it('lists every resolution and bitrate with codecs and frame rate', () => {
    const parsed = master(hlsMaster);
    expect(parsed.variants).toEqual([
      {
        id: 'video-0',
        protocol: 'hls',
        bandwidth: 6221600,
        averageBandwidth: 5000000,
        width: 1920,
        height: 1080,
        frameRate: 29.97,
        codecs: ['avc1.640028', 'mp4a.40.2'],
        videoCodec: 'avc1.640028',
        audioCodec: 'mp4a.40.2',
        audioOnly: false,
        audioTrackIds: ['audio-0', 'audio-1'],
        hls: { playlistUrl: 'https://cdn.example.com/vod/movie/video/1080p/prog_index.m3u8', audioGroupId: 'aac' },
      },
      expect.objectContaining({
        id: 'video-1',
        height: 720,
        hls: {
          playlistUrl: 'https://cdn2.example.com/vod/movie/video/720p/prog_index.m3u8?token=abc123',
          audioGroupId: 'aac',
        },
      }),
      expect.objectContaining({
        id: 'video-2',
        height: 360,
        hls: { playlistUrl: 'https://cdn.example.com/vod/shared/360p/prog_index.m3u8', audioGroupId: 'aac' },
      }),
    ]);
  });

  it('lists separate audio renditions with language and default flag; closed captions are not audio', () => {
    expect(master(hlsMaster).audioTracks).toEqual([
      {
        id: 'audio-0',
        name: 'English',
        language: 'en',
        isDefault: true,
        hls: { groupId: 'aac', playlistUrl: 'https://cdn.example.com/vod/movie/audio/en/prog_index.m3u8' },
      },
      {
        id: 'audio-1',
        name: 'Français, stéréo',
        language: 'fr',
        isDefault: false,
        hls: { groupId: 'aac', playlistUrl: 'https://cdn.example.com/vod/movie/audio/fr/prog_index.m3u8' },
      },
    ]);
    expect(master(hlsMaster).iFrameUrls).toEqual(['https://cdn.example.com/vod/movie/video/1080p/iframe_index.m3u8']);
  });

  it('recognises muxed audio (no URI), audio-only variants and variants without a resolution', () => {
    const parsed = master(hlsMasterMuxed);
    expect(parsed.audioTracks).toEqual([
      { id: 'audio-0', name: 'Main', language: 'en', isDefault: true, hls: { groupId: 'main' } },
      {
        id: 'audio-1',
        name: 'Commentary',
        language: 'en',
        isDefault: false,
        hls: { groupId: 'main', playlistUrl: 'https://cdn.example.com/vod/movie/commentary.m3u8' },
      },
    ]);
    expect(parsed.variants.map((v) => [v.height, v.frameRate, v.audioOnly, v.audioTrackIds])).toEqual([
      [720, 59.94, false, ['audio-0', 'audio-1']],
      [undefined, undefined, false, []],
      [undefined, undefined, true, []],
    ]);
  });

  it('skips variants with unusable URIs and rejects playlists without any usable variant', () => {
    const text = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\njavascript:alert(1)\n#EXT-X-STREAM-INF:BANDWIDTH=2\nok.m3u8';
    expect(master(text).variants.map((v) => v.hls?.playlistUrl)).toEqual(['https://cdn.example.com/vod/movie/ok.m3u8']);
    expectInvalid(() => parseHlsPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nskd://nope', MASTER_URL));
  });
});

describe('parseHlsPlaylist: media playlists', () => {
  it('reads duration and live state', () => {
    expect(media(hlsTs)).toMatchObject({ kind: 'media', isLive: false, durationSec: 34.5, segmentCount: 4, targetDuration: 10 });
    expect(media(hlsLive)).toMatchObject({ isLive: true, targetDuration: 4 });
  });

  it('rejects input that is not an HLS playlist', () => {
    expectInvalid(() => parseHlsPlaylist('<html>Forbidden</html>', MEDIA_URL));
    expectInvalid(() => parseHlsPlaylist('#EXTM3U\n#EXTINF:123,Artist - Song\nsong.mp3', MEDIA_URL));
    expectInvalid(() => parseHlsPlaylist('#EXTM3U\n', MEDIA_URL));
  });

  it('falls back to the target duration for unreadable EXTINF values (parser behaviour)', () => {
    expect(media('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:-5,\na.ts\n#EXTINF:abc,\nb.ts').durationSec).toBe(8);
  });

  it('caps the number of segments', () => {
    const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:1'];
    for (let i = 0; i <= HLS_LIMITS.maxSegments; i++) lines.push('#EXTINF:1,', `s${i}.ts`);
    expectInvalid(() => parseHlsPlaylist(lines.join('\n'), MEDIA_URL));
  });
});

describe('toMediaSegments', () => {
  it('orders MPEG-TS segments and resolves relative and absolute URLs', () => {
    const segments = toMediaSegments(media(hlsTs), MAIN);
    expect(segments.map((s) => [s.index, s.kind, s.url, s.duration, s.mediaSequence, s.container])).toEqual([
      [0, 'media', 'https://cdn.example.com/vod/movie/video/1080p/segment_00000.ts', 10, 0, 'mpeg-ts'],
      [1, 'media', 'https://cdn.example.com/vod/movie/video/1080p/segment_00001.ts', 10, 1, 'mpeg-ts'],
      [2, 'media', 'https://cdn2.example.com/vod/movie/segment_00002.ts?sig=xyz', 10, 2, 'mpeg-ts'],
      [3, 'media', 'https://cdn.example.com/vod/movie/video/other/segment_00003.ts', 4.5, 3, 'mpeg-ts'],
    ]);
    expect(segments.map((s) => s.id)).toEqual(['main:0', 'main:1', 'main:2', 'main:3']);
  });

  it('emits the fMP4 initialization section once, before the media segments that need it', () => {
    const segments = toMediaSegments(media(hlsFmp4), MAIN);
    expect(segments.map((s) => [s.index, s.kind, s.url.split('/').pop(), s.byteRange, s.initSegmentId, s.container])).toEqual([
      [0, 'init', 'init.mp4', { offset: 0, length: 720 }, undefined, 'fmp4'],
      [1, 'media', 'main.mp4', { offset: 720, length: 1048576 }, 'main:0', 'fmp4'],
      [2, 'media', 'main.mp4', { offset: 1049296, length: 1048000 }, 'main:0', 'fmp4'],
      [3, 'media', 'fileSequence3.m4s', undefined, 'main:0', 'fmp4'],
      [4, 'media', 'fileSequence4.m4s', undefined, 'main:0', 'fmp4'],
    ]);
  });

  it('emits a new initialization section when EXT-X-MAP changes', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MAP:URI="init-a.mp4"',
      '#EXTINF:4,',
      'a1.m4s',
      '#EXT-X-DISCONTINUITY',
      '#EXT-X-MAP:URI="init-b.mp4"',
      '#EXTINF:4,',
      'b1.m4s',
      '#EXTINF:4,',
      'b2.m4s',
    ].join('\n');
    const segments = toMediaSegments(media(text), MAIN);
    expect(segments.map((s) => [s.kind, s.url.split('/').pop(), s.initSegmentId, s.discontinuity])).toEqual([
      ['init', 'init-a.mp4', undefined, 0],
      ['media', 'a1.m4s', 'main:0', 0],
      ['init', 'init-b.mp4', undefined, 1],
      ['media', 'b1.m4s', 'main:2', 1],
      ['media', 'b2.m4s', 'main:2', 1],
    ]);
  });

  it('computes implicit byte-range offsets within one resource', () => {
    const segments = toMediaSegments(media(hlsByteRange), MAIN);
    expect(segments.map((s) => s.byteRange)).toEqual([
      { offset: 0, length: 75232 },
      { offset: 75232, length: 82112 },
      { offset: 157344, length: 69864 },
    ]);
    expect(new Set(segments.map((s) => s.url))).toEqual(new Set(['https://cdn.example.com/vod/movie/video/1080p/movie.ts']));
  });

  it('applies AES-128 keys with explicit or sequence-derived IVs, key rotation and METHOD=NONE', () => {
    const segments = toMediaSegments(media(hlsDiscontinuity), MAIN);
    expect(segments.map((s) => [s.mediaSequence, s.discontinuity, s.encryption])).toEqual([
      [100, 3, { method: 'AES-128', keyUrl: 'https://cdn.example.com/vod/movie/video/1080p/keys/k1.bin', iv: '00000000000000000000000000000064' }],
      [101, 3, { method: 'AES-128', keyUrl: 'https://cdn.example.com/vod/movie/video/1080p/keys/k1.bin', iv: '00000000000000000000000000000065' }],
      [102, 4, { method: 'AES-128', keyUrl: 'https://keys.example.com/k2.bin', iv: '0000000000000000000000000000abcd' }],
      [103, 5, undefined],
    ]);
  });

  it('records SAMPLE-AES with an identity key for the merge step to handle', () => {
    expect(toMediaSegments(media(hlsSampleAes), MAIN)[0]?.encryption).toEqual({
      method: 'SAMPLE-AES',
      keyUrl: 'https://keys.example.com/sample.key',
      iv: '0123456789abcdef0123456789abcdef',
    });
  });

  it('tags segments with their track', () => {
    const audio = toMediaSegments(media(hlsTs), { id: 'audio-1', type: 'audio' });
    expect(audio[0]).toMatchObject({ id: 'audio-1:0', trackId: 'audio-1', trackType: 'audio' });
  });

  it('rejects unusable segment and key URIs', () => {
    expectInvalid(() => toMediaSegments(media('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nftp://x/a.ts'), MAIN));
    expectInvalid(
      () =>
        toMediaSegments(
          media('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-KEY:METHOD=AES-128,URI="skd://x"\n#EXTINF:4,\na.ts'),
          MAIN,
        ),
      'UNSUPPORTED',
    );
  });
});
