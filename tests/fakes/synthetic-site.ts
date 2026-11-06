import { dashManifest, hlsMasterPlaylist, hlsMediaPlaylist } from '@tests/fixtures/media/synthetic-manifests';
import type { Rendition, SyntheticMedia } from '@tests/fixtures/media/synthetic-media';
import type { FakeMediaSite } from './media-site';

/**
 * Serves synthetic media (real H.264/AAC segments) from a FakeMediaSite the
 * way CDNs do, for tests that run downloads through FFmpeg.
 */

export const SYNTHETIC_BASE = 'https://media.example.com/';

function serveRendition(site: FakeMediaSite, dir: string, rendition: Rendition, numberFrom = 0): void {
  if (rendition.init) site.serve(`${dir}init.mp4`, rendition.init, 'video/mp4');
  const ext = rendition.init ? 'm4s' : 'ts';
  rendition.segments.forEach((segment, index) => {
    site.serve(`${dir}seg-${index + numberFrom}.${ext}`, segment, rendition.init ? 'video/mp4' : 'video/mp2t');
  });
}

/**
 * HLS with every video rendition as a variant and one English audio
 * rendition, as MPEG-TS or fragmented MP4. Returns the multivariant URL.
 */
export function serveHls(site: FakeMediaSite, media: SyntheticMedia, packaging: 'ts' | 'fmp4', base = `${SYNTHETIC_BASE}hls-${packaging}/`): string {
  const set = media[packaging];
  for (const video of media.options.video) {
    const rendition = set.video[video.name] as Rendition;
    site.serve(`${base}${video.name}/index.m3u8`, hlsMediaPlaylist(rendition));
    serveRendition(site, `${base}${video.name}/`, rendition);
  }
  site.serve(`${base}audio/index.m3u8`, hlsMediaPlaylist(set.audio));
  serveRendition(site, `${base}audio/`, set.audio);
  const master = `${base}master.m3u8`;
  site.serve(
    master,
    hlsMasterPlaylist(
      media.options.video.map((video) => ({ uri: `${video.name}/index.m3u8`, width: video.width, height: video.height, rendition: set.video[video.name] as Rendition })),
      { uri: 'audio/index.m3u8', name: 'English', language: 'en', rendition: set.audio },
    ),
  );
  return master;
}

/** A single media playlist of muxed audio+video MPEG-TS segments. Returns its URL. */
export function serveMuxedHls(site: FakeMediaSite, media: SyntheticMedia, base = `${SYNTHETIC_BASE}muxed/`): string {
  site.serve(`${base}index.m3u8`, hlsMediaPlaylist(media.ts.muxed));
  serveRendition(site, base, media.ts.muxed);
  return `${base}index.m3u8`;
}

/** DASH with separate video and audio adaptation sets (fragmented MP4, SegmentTimeline). Returns the MPD URL. */
export function serveDash(site: FakeMediaSite, media: SyntheticMedia, base = `${SYNTHETIC_BASE}dash/`): string {
  for (const video of media.options.video) serveRendition(site, `${base}${video.name}/`, media.fmp4.video[video.name] as Rendition, 1);
  serveRendition(site, `${base}audio-en/`, media.fmp4.audio, 1);
  const mpd = `${base}manifest.mpd`;
  site.serve(
    mpd,
    dashManifest(
      media.options.video.map((video) => ({ id: video.name, width: video.width, height: video.height, rendition: media.fmp4.video[video.name] as Rendition })),
      { id: 'audio-en', language: 'en', rendition: media.fmp4.audio },
    ),
    'application/dash+xml',
  );
  return mpd;
}
