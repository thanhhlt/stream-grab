import { bodyFor, FakeMediaSite } from './media-site';

export const MOVIE_BASE = 'https://cdn.example.com/vod/';
export const SEGMENT_SIZE = 3000;

/** An HLS media playlist of `count` 4-second segments named seg-N.ts. */
export function mediaPlaylist(count: number, query = '', extra = ''): string {
  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0', extra];
  for (let i = 0; i < count; i++) lines.push('#EXTINF:4,', `seg-${i}.ts${query}`);
  lines.push('#EXT-X-ENDLIST');
  return lines.filter(Boolean).join('\n');
}

/**
 * A movie with 720p/360p variants and one English audio rendition (video-0 =
 * 720p, video-1 = 360p, audio-0 = English), optionally signed with a token.
 */
export function movieSite(segments = 10, token = '', site: FakeMediaSite = new FakeMediaSite()): FakeMediaSite {
  const query = token ? `?token=${token}` : '';
  site.serve(
    `${MOVIE_BASE}master.m3u8${query}`,
    [
      '#EXTM3U',
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/index.m3u8${query}"`,
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="a"',
      `v720/index.m3u8${query}`,
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="a"',
      `v360/index.m3u8${query}`,
    ].join('\n'),
  );
  for (const path of ['v720', 'v360', 'audio']) {
    site.serve(`${MOVIE_BASE}${path}/index.m3u8${query}`, mediaPlaylist(segments, query));
    for (let i = 0; i < segments; i++) {
      const url = `${MOVIE_BASE}${path}/seg-${i}.ts${query}`;
      site.serve(url, bodyFor(url, SEGMENT_SIZE));
    }
  }
  return site;
}
