import { describe, expect, it } from 'vitest';
import { ManifestFetcher, type FetchFunction } from '@/core/network/manifest-fetcher';
import { DashAdapter } from '@/core/protocols/dash/dash-adapter';
import { HlsAdapter } from '@/core/protocols/hls/hls-adapter';
import { StreamGrabError } from '@/shared/utils/errors';
import dashSubtitles from '@tests/fixtures/manifests/dash/subtitles.mpd?raw';
import hlsMasterSubtitles from '@tests/fixtures/manifests/hls/master-subtitles.m3u8?raw';
import hlsTs from '@tests/fixtures/manifests/hls/media-ts.m3u8?raw';

/** A fake web server: URL → body. */
function fetcherFor(routes: Record<string, string>): ManifestFetcher {
  const fetch: FetchFunction = (url) => {
    const body = routes[url];
    return Promise.resolve(body === undefined ? new Response('missing', { status: 404 }) : new Response(body));
  };
  return new ManifestFetcher({ fetch, acquireContext: () => Promise.resolve(() => Promise.resolve()) });
}

async function rejection(promise: Promise<unknown>): Promise<StreamGrabError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StreamGrabError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('HLS subtitle renditions (0.7.0)', () => {
  const MASTER = 'https://cdn.example.com/show/master.m3u8';
  const SUB_EN = 'https://cdn.example.com/show/subs/en/index.m3u8';
  const SUB_VI = 'https://cdn.example.com/show/subs/vi/index.m3u8';
  const V720 = 'https://cdn.example.com/show/video/720p/index.m3u8';
  const subtitlePlaylist = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:10',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXTINF:10,',
    'seg-0.vtt',
    '#EXTINF:10,',
    'seg-1.webvtt?sig=1',
    '#EXT-X-ENDLIST',
  ].join('\n');
  const adapter = () =>
    new HlsAdapter({ fetcher: fetcherFor({ [MASTER]: hlsMasterSubtitles, [V720]: hlsTs, 'https://cdn.example.com/show/video/360p/index.m3u8': hlsTs, [SUB_EN]: subtitlePlaylist, [SUB_VI]: subtitlePlaylist }) });

  it('lists WebVTT renditions with language, default and forced flags, and links them to their variants', async () => {
    const manifest = await adapter().parseManifest(MASTER);
    expect(manifest.subtitleTracks).toEqual([
      { id: 'subtitle-0', name: 'English', language: 'en', isDefault: true, forced: false, hls: { groupId: 'subs', playlistUrl: SUB_EN } },
      { id: 'subtitle-1', name: 'Tiếng Việt', language: 'vi', isDefault: false, forced: false, hls: { groupId: 'subs', playlistUrl: SUB_VI } },
      {
        id: 'subtitle-2',
        name: 'English (forced)',
        language: 'en',
        isDefault: false,
        forced: true,
        hls: { groupId: 'subs', playlistUrl: 'https://cdn.example.com/show/subs/en-forced/index.m3u8' },
      },
    ]);
    const [v720, v360] = manifest.variants;
    expect(v720?.subtitleTrackIds).toEqual(['subtitle-0', 'subtitle-1', 'subtitle-2']);
    expect(v720?.hls?.subtitleGroupId).toBe('subs');
    expect(v360?.subtitleTrackIds).toBeUndefined();
    // Subtitle playlists belong to this stream; they are not listed as separate videos.
    expect(manifest.childUrls).toContain(SUB_VI);
  });

  it('adds only the requested subtitle segments, typed as WebVTT', async () => {
    const hls = adapter();
    const manifest = await hls.parseManifest(MASTER);
    const variant = manifest.variants[0]!;
    const plain = await hls.getSegments(manifest, variant);
    expect(plain.some((segment) => segment.trackType === 'subtitle')).toBe(false);

    const segments = await hls.getSegments(manifest, variant, { subtitleTrackIds: ['subtitle-1'] });
    const subtitles = segments.filter((segment) => segment.trackType === 'subtitle');
    expect(subtitles.map((segment) => [segment.id, segment.url, segment.container, segment.duration])).toEqual([
      ['subtitle-1:0', 'https://cdn.example.com/show/subs/vi/seg-0.vtt', 'webvtt', 10],
      ['subtitle-1:1', 'https://cdn.example.com/show/subs/vi/seg-1.webvtt?sig=1', 'webvtt', 10],
    ]);
  });

  it('refuses a subtitle track the variant does not reference', async () => {
    const hls = adapter();
    const manifest = await hls.parseManifest(MASTER);
    const error = await rejection(hls.getSegments(manifest, manifest.variants[1]!, { subtitleTrackIds: ['subtitle-0'] }));
    expect(error.code).toBe('UNSUPPORTED');
  });

  it('leaves manifests without subtitles unchanged', async () => {
    const manifest = await adapter().parseManifest(V720);
    expect(manifest.subtitleTracks).toBeUndefined();
  });
});

describe('DASH text adaptation sets (0.7.0)', () => {
  const MPD = 'https://cdn.example.com/vod/movie/manifest.mpd';
  const adapter = () => new DashAdapter({ fetcher: fetcherFor({ [MPD]: dashSubtitles }) });
  const tracksOf = (segments: { trackType: string; trackId: string }[]) => [...new Set(segments.map((s) => `${s.trackType}:${s.trackId}`))];

  it('lists text/vtt sets (one file or segments) and skips fMP4 text', async () => {
    const manifest = await adapter().parseManifest(MPD);
    expect(manifest.subtitleTracks).toEqual([
      { id: 'subtitle-0', name: 'English', language: 'en', isDefault: false, forced: false, dash: { representationId: 'sub-en' } },
      { id: 'subtitle-1', name: 'fr', language: 'fr', isDefault: false, forced: false, dash: { representationId: 'sub-fr' } },
    ]);
    expect(manifest.variants[0]?.subtitleTrackIds).toEqual(['subtitle-0', 'subtitle-1']);
  });

  it('returns a single-file track as one segment and a templated one as segments', async () => {
    const dash = adapter();
    const manifest = await dash.parseManifest(MPD);
    const segments = await dash.getSegments(manifest, manifest.variants[0]!, { subtitleTrackIds: ['subtitle-0', 'subtitle-1'] });
    expect(tracksOf(segments)).toEqual(['main:main', 'audio:audio-0', 'subtitle:subtitle-0', 'subtitle:subtitle-1']);
    const en = segments.filter((segment) => segment.trackId === 'subtitle-0');
    expect(en.map((segment) => [segment.kind, segment.url, segment.container, segment.duration])).toEqual([
      ['media', 'https://cdn.example.com/vod/movie/subs/en.vtt', 'webvtt', 30],
    ]);
    const fr = segments.filter((segment) => segment.trackId === 'subtitle-1');
    expect(fr.map((segment) => segment.url)).toEqual([
      'https://cdn.example.com/vod/movie/subs/fr/1.vtt',
      'https://cdn.example.com/vod/movie/subs/fr/2.vtt',
      'https://cdn.example.com/vod/movie/subs/fr/3.vtt',
    ]);
    expect(fr.every((segment) => segment.kind === 'media' && segment.container === 'webvtt')).toBe(true);
  });

  it('refuses an unknown subtitle track', async () => {
    const dash = adapter();
    const manifest = await dash.parseManifest(MPD);
    const error = await rejection(dash.getSegments(manifest, manifest.variants[0]!, { subtitleTrackIds: ['subtitle-9'] }));
    expect(error.code).toBe('UNSUPPORTED');
  });
});
