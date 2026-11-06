import { Parser, type Manifest, type Segment } from 'm3u8-parser';
import type { MediaSegment, SegmentEncryption, TrackType } from '@/core/models/media-segment';
import type { AudioTrack } from '@/core/models/streaming-manifest';
import type { VideoVariant } from '@/core/models/video-variant';
import { codecKind, splitCodecs } from '@/core/protocols/codecs';
import {
  containerFromUrl,
  invalidManifest as invalid,
  nonEmptyString,
  nonNegativeInt,
  positiveNumber,
  toByteRange,
} from '@/core/protocols/manifest-values';
import { SegmentListBuilder, type MediaFields } from '@/core/protocols/segment-builder';
import { errorMessage, StreamGrabError } from '@/shared/utils/errors';
import { resolveHttpUrl } from '@/shared/utils/url';
import { ivFromMediaSequence, ivFromWords, resolveKeyUrl, scanHlsKeys, type KeyScan } from './hls-keys';

/**
 * Normalises HLS playlists (parsed by m3u8-parser) into StreamGrab's models.
 * Pure and synchronous. Playlists are untrusted input: every value taken from
 * the parser is validated, URLs are resolved against the playlist's final URL
 * and only http(s) is accepted, and sizes are capped.
 */

export const HLS_LIMITS = {
  maxSegments: 200_000,
  maxVariants: 200,
  maxAudioTracks: 100,
} as const;

export interface ParsedMasterPlaylist {
  kind: 'master';
  /** Final URL of the playlist (base for relative references). */
  url: string;
  variants: VideoVariant[];
  audioTracks: AudioTrack[];
  iFrameUrls: string[];
  keys: KeyScan;
}

export interface ParsedMediaPlaylist {
  kind: 'media';
  url: string;
  targetDuration?: number;
  /** No EXT-X-ENDLIST and not PLAYLIST-TYPE:VOD: the server keeps appending segments. */
  isLive: boolean;
  /** Sum of segment durations, seconds. */
  durationSec: number;
  segmentCount: number;
  keys: KeyScan;
  /** Parser output; converted lazily by toMediaSegments(). */
  raw: { segments: Segment[]; mediaSequence: number; discontinuitySequence: number };
}

export type ParsedPlaylist = ParsedMasterPlaylist | ParsedMediaPlaylist;

const BOM = new RegExp('^\\uFEFF');

function runParser(text: string, url: string): Manifest {
  try {
    const parser = new Parser({ uri: url });
    parser.push(text);
    parser.end();
    return parser.manifest;
  } catch (error) {
    throw invalid(`Malformed HLS playlist: ${errorMessage(error)}`);
  }
}

/**
 * Parses an HLS multivariant ("master") or media playlist.
 * @throws StreamGrabError MANIFEST_INVALID for anything that is not a usable HLS playlist.
 */
export function parseHlsPlaylist(text: string, url: string): ParsedPlaylist {
  const body = text.replace(BOM, '');
  if (!/^\s*#EXTM3U/.test(body)) throw invalid('Not an HLS playlist (missing #EXTM3U)');
  const isMaster = /^#EXT-X-STREAM-INF:/m.test(body);
  // EXT-X-TARGETDURATION is mandatory in media playlists; plain extended M3U lacks it.
  const isMedia = /^#EXT-X-TARGETDURATION:/m.test(body);
  if (!isMaster && !isMedia) throw invalid('Not an HLS playlist (no variant streams or target duration)');

  const manifest = runParser(body, url);
  const keys = scanHlsKeys(body);
  return isMaster ? toMaster(manifest, url, keys) : toMedia(manifest, url, keys);
}

function toMaster(manifest: Manifest, url: string, keys: KeyScan): ParsedMasterPlaylist {
  const audioTracks: AudioTrack[] = [];
  for (const [groupId, members] of Object.entries(manifest.mediaGroups?.['AUDIO'] ?? {})) {
    for (const [name, rendition] of Object.entries(members)) {
      if (audioTracks.length >= HLS_LIMITS.maxAudioTracks) break;
      const trackName = nonEmptyString(name);
      if (trackName === undefined) continue;
      const hls: NonNullable<AudioTrack['hls']> = { groupId };
      if (rendition.uri !== undefined) {
        const playlistUrl = resolveHttpUrl(rendition.uri, url);
        if (playlistUrl === null) continue; // unusable reference: skip rather than guess
        hls.playlistUrl = playlistUrl;
      }
      const track: AudioTrack = { id: `audio-${audioTracks.length}`, name: trackName, isDefault: rendition.default, hls };
      const language = nonEmptyString(rendition.language, 35);
      if (language !== undefined) track.language = language;
      audioTracks.push(track);
    }
  }

  const variants: VideoVariant[] = [];
  for (const playlist of manifest.playlists ?? []) {
    if (variants.length >= HLS_LIMITS.maxVariants) break;
    const playlistUrl = resolveHttpUrl(playlist.uri, url);
    if (playlistUrl === null) continue;
    const attributes = playlist.attributes;
    const codecs = splitCodecs(typeof attributes.CODECS === 'string' ? attributes.CODECS : undefined);
    const videoCodec = codecs.find((codec) => codecKind(codec) === 'video');
    const audioCodec = codecs.find((codec) => codecKind(codec) === 'audio');
    const width = nonNegativeInt(attributes.RESOLUTION?.width);
    const height = nonNegativeInt(attributes.RESOLUTION?.height);
    const audioGroupId = typeof attributes.AUDIO === 'string' ? attributes.AUDIO : undefined;

    const variant: VideoVariant = {
      id: `video-${variants.length}`,
      protocol: 'hls',
      codecs,
      audioOnly: height === undefined && codecs.length > 0 && videoCodec === undefined,
      audioTrackIds: audioGroupId === undefined ? [] : audioTracks.filter((t) => t.hls?.groupId === audioGroupId).map((t) => t.id),
      hls: audioGroupId === undefined ? { playlistUrl } : { playlistUrl, audioGroupId },
    };
    const optional = {
      bandwidth: nonNegativeInt(attributes.BANDWIDTH),
      averageBandwidth: nonNegativeInt(attributes['AVERAGE-BANDWIDTH']),
      width,
      height,
      frameRate: positiveNumber(attributes['FRAME-RATE']),
    };
    for (const [key, value] of Object.entries(optional)) {
      if (value !== undefined) variant[key as keyof typeof optional] = value;
    }
    if (videoCodec !== undefined) variant.videoCodec = videoCodec;
    if (audioCodec !== undefined) variant.audioCodec = audioCodec;
    variants.push(variant);
  }
  if (variants.length === 0) throw invalid('Multivariant playlist lists no usable variant streams');

  const iFrameUrls = manifest.iFramePlaylists
    .map((playlist) => resolveHttpUrl(playlist.uri, url))
    .filter((resolved): resolved is string => resolved !== null);

  return { kind: 'master', url, variants, audioTracks, iFrameUrls, keys };
}

function toMedia(manifest: Manifest, url: string, keys: KeyScan): ParsedMediaPlaylist {
  const segments = manifest.segments;
  if (segments.length > HLS_LIMITS.maxSegments) {
    throw invalid(`Playlist has ${segments.length} segments; the limit is ${HLS_LIMITS.maxSegments}`);
  }
  let durationSec = 0;
  for (const segment of segments) {
    if (!Number.isFinite(segment.duration) || segment.duration < 0) throw invalid('Segment with an invalid duration');
    durationSec += segment.duration;
  }
  const playlist: ParsedMediaPlaylist = {
    kind: 'media',
    url,
    isLive: manifest.endList !== true && manifest.playlistType !== 'VOD',
    durationSec,
    segmentCount: segments.length,
    keys,
    raw: {
      segments,
      mediaSequence: nonNegativeInt(manifest.mediaSequence) ?? 0,
      discontinuitySequence: nonNegativeInt(manifest.discontinuitySequence) ?? 0,
    },
  };
  const targetDuration = positiveNumber(manifest.targetDuration);
  if (targetDuration !== undefined) playlist.targetDuration = targetDuration;
  return playlist;
}

// ------------------------------------------------------------ segments

function toEncryption(segment: Segment, playlistUrl: string, mediaSequence: number, position: number): SegmentEncryption | undefined {
  const key = segment.key;
  if (!key) return undefined;
  const method = key.method.toUpperCase();
  if (method === 'NONE') return undefined;
  if (method !== 'AES-128' && method !== 'SAMPLE-AES' && method !== 'SAMPLE-AES-CTR') {
    throw new StreamGrabError(`Encryption method ${method} is not supported`, 'UNSUPPORTED');
  }
  const keyUrl = resolveKeyUrl(key.uri, playlistUrl);
  if (keyUrl === null) throw new StreamGrabError(`Segment ${position} uses a key URI scheme that is not supported`, 'UNSUPPORTED');
  let iv: string;
  if (key.iv === undefined) {
    iv = ivFromMediaSequence(mediaSequence);
  } else {
    const explicit = ivFromWords(key.iv);
    if (explicit === null) throw invalid(`Segment ${position} has a malformed IV`);
    iv = explicit;
  }
  return { method: method === 'AES-128' ? 'AES-128' : 'SAMPLE-AES', keyUrl, iv };
}

/**
 * Turns a media playlist into ordered MediaSegments of one track. An init
 * segment is emitted before the first media segment that needs it and again
 * whenever EXT-X-MAP changes.
 * @throws StreamGrabError MANIFEST_INVALID / UNSUPPORTED
 */
export function toMediaSegments(playlist: ParsedMediaPlaylist, track: { id: string; type: TrackType }): MediaSegment[] {
  const builder = new SegmentListBuilder(track);
  let discontinuity = playlist.raw.discontinuitySequence;

  playlist.raw.segments.forEach((segment, i) => {
    const position = i + 1;
    // A discontinuity before the first segment is already counted in EXT-X-DISCONTINUITY-SEQUENCE.
    if (i > 0 && segment.discontinuity === true) discontinuity += 1;
    const mediaSequence = playlist.raw.mediaSequence + i;
    const url = resolveHttpUrl(segment.uri, playlist.url);
    if (url === null) throw invalid(`Segment ${position} has an unsupported URI`);

    if (segment.map) {
      const mapUrl = resolveHttpUrl(segment.map.uri, playlist.url);
      if (mapUrl === null) throw invalid(`Initialization section of segment ${position} has an unsupported URI`);
      const mapRange = toByteRange(segment.map.byterange, 'Initialization section');
      builder.setInit(mapRange ? { url: mapUrl, byteRange: mapRange } : { url: mapUrl }, discontinuity);
    } else {
      builder.setInit(undefined, discontinuity);
    }

    const fields: MediaFields = {
      url,
      duration: segment.duration,
      mediaSequence,
      discontinuity,
      container: segment.map ? 'fmp4' : containerFromUrl(url, 'unknown'),
    };
    const byteRange = toByteRange(segment.byterange, `Segment ${position}`);
    if (byteRange) fields.byteRange = byteRange;
    const encryption = toEncryption(segment, playlist.url, mediaSequence, position);
    if (encryption) fields.encryption = encryption;
    builder.addMedia(fields);
  });
  return builder.segments;
}
