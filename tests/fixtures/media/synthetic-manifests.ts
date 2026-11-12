/**
 * HLS playlists and DASH MPDs describing synthetic media (synthetic-media.ts)
 * with the real segment durations, for the fixture site and the fake media
 * sites of the tests. Plain relative imports only (runs in Node directly).
 */
import type { Rendition } from './synthetic-media.ts';

export const H264_CODEC = 'avc1.640014';
export const AAC_CODEC = 'mp4a.40.2';

const seconds = (value: number): string => value.toFixed(6);

/** Average bits per second of a rendition. */
export function bandwidthOf(rendition: Rendition): number {
  const bytes = rendition.segments.reduce((sum, segment) => sum + segment.length, rendition.init?.length ?? 0);
  const duration = rendition.durations.reduce((sum, value) => sum + value, 0);
  return Math.max(1000, Math.round((bytes * 8) / Math.max(duration, 0.001)));
}

export function totalSeconds(rendition: Rendition): number {
  return rendition.durations.reduce((sum, value) => sum + value, 0);
}

/**
 * Media playlist naming segments `seg-<index>.<ext>` (and `init.mp4` for
 * fMP4), each followed by `query` (e.g. a signed token).
 */
export function hlsMediaPlaylist(rendition: Rendition, query = ''): string {
  const fmp4 = rendition.init !== undefined;
  const lines = [
    '#EXTM3U',
    `#EXT-X-VERSION:${fmp4 ? 7 : 3}`,
    `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...rendition.durations))}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
  ];
  if (fmp4) lines.push(`#EXT-X-MAP:URI="init.mp4${query}"`);
  rendition.durations.forEach((duration, index) => {
    lines.push(`#EXTINF:${seconds(duration)},`, `seg-${index}.${fmp4 ? 'm4s' : 'ts'}${query}`);
  });
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

export interface HlsVariantEntry {
  uri: string;
  width: number;
  height: number;
  rendition: Rendition;
}

export interface HlsAudioEntry {
  uri: string;
  name: string;
  language: string;
  rendition: Rendition;
}

/** A WebVTT subtitle rendition (0.7.0). */
export interface HlsSubtitleEntry {
  uri: string;
  name: string;
  language: string;
}

/**
 * Multivariant playlist: video variants, optionally sharing one alternative audio rendition and
 * one group of subtitle renditions.
 */
export function hlsMasterPlaylist(variants: readonly HlsVariantEntry[], audio?: HlsAudioEntry, subtitles: readonly HlsSubtitleEntry[] = []): string {
  const lines = ['#EXTM3U', '#EXT-X-INDEPENDENT-SEGMENTS'];
  if (audio) {
    lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="${audio.name}",LANGUAGE="${audio.language}",DEFAULT=YES,AUTOSELECT=YES,URI="${audio.uri}"`);
  }
  for (const subtitle of subtitles) {
    lines.push(`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${subtitle.name}",LANGUAGE="${subtitle.language}",AUTOSELECT=YES,URI="${subtitle.uri}"`);
  }
  for (const variant of variants) {
    const bandwidth = bandwidthOf(variant.rendition) + (audio ? bandwidthOf(audio.rendition) : 0);
    const codecs = audio || variant.rendition.init === undefined ? `${H264_CODEC},${AAC_CODEC}` : H264_CODEC;
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${variant.width}x${variant.height},CODECS="${codecs}"${audio ? ',AUDIO="aud"' : ''}${subtitles.length > 0 ? ',SUBTITLES="subs"' : ''}`,
      variant.uri,
    );
  }
  return lines.join('\n');
}

/** SegmentTimeline with runs of equal durations folded into `r` repeats (timescale 1000). */
function timeline(rendition: Rendition): string {
  const entries: { d: number; r: number }[] = [];
  for (const duration of rendition.durations) {
    const d = Math.round(duration * 1000);
    const last = entries.at(-1);
    if (last?.d === d) last.r += 1;
    else entries.push({ d, r: 0 });
  }
  return entries.map((entry, index) => `<S ${index === 0 ? 't="0" ' : ''}d="${entry.d}"${entry.r > 0 ? ` r="${entry.r}"` : ''}/>`).join('');
}

function representation(id: string, rendition: Rendition, attributes: string): string {
  return `<Representation id="${id}" bandwidth="${bandwidthOf(rendition)}" ${attributes}>
        <SegmentTemplate timescale="1000" startNumber="1" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/seg-$Number$.m4s">
          <SegmentTimeline>${timeline(rendition)}</SegmentTimeline>
        </SegmentTemplate>
      </Representation>`;
}

export interface DashVideoEntry {
  id: string;
  width: number;
  height: number;
  rendition: Rendition;
}

/**
 * Static MPD with separate video and audio adaptation sets. Segments are
 * `<id>/init.mp4` and `<id>/seg-<n>.m4s` with n from 1 (fixture index + 1).
 */
export function dashManifest(video: readonly DashVideoEntry[], audio: { id: string; language: string; rendition: Rendition }): string {
  const duration = Math.max(...video.map((entry) => totalSeconds(entry.rendition)));
  return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" profiles="urn:mpeg:dash:profile:isoff-live:2011"
     mediaPresentationDuration="PT${duration.toFixed(3)}S" minBufferTime="PT2S">
  <Period id="1" start="PT0S">
    <AdaptationSet mimeType="video/mp4" contentType="video" segmentAlignment="true">
      ${video.map((entry) => representation(entry.id, entry.rendition, `width="${entry.width}" height="${entry.height}" codecs="${H264_CODEC}"`)).join('\n      ')}
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" contentType="audio" lang="${audio.language}">
      ${representation(audio.id, audio.rendition, `codecs="${AAC_CODEC}" audioSamplingRate="48000"`)}
    </AdaptationSet>
  </Period>
</MPD>`;
}
