import { parse, type MpdManifest, type MpdPlaylist } from 'mpd-parser';
import type { MediaSegment, TrackType } from '@/core/models/media-segment';
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
import { errorMessage } from '@/shared/utils/errors';
import { resolveHttpUrl } from '@/shared/utils/url';
import { scanDashManifest, type DashScan } from './dash-scan';

/**
 * Normalises MPEG-DASH MPDs (parsed by mpd-parser) into StreamGrab's models.
 *
 * mpd-parser expands SegmentTemplate ($Number$, $Time$, $RepresentationID$,
 * $Bandwidth$ with width formats), SegmentTimeline (including repeats),
 * SegmentList (URLs or byte ranges), BaseURL inheritance, and joins periods by
 * Representation@id. Its output is validated here; URLs must be http(s).
 */

export const DASH_LIMITS = {
  maxSegmentsPerRepresentation: 200_000,
  maxRepresentations: 200,
  maxAudioTracks: 100,
} as const;

export interface ParsedMpd {
  /** Final URL of the MPD (base for relative references). */
  url: string;
  isLive: boolean;
  /** mediaPresentationDuration, seconds (static MPDs). */
  durationSec?: number;
  /** MPD@minimumUpdatePeriod in ms (dynamic MPDs). */
  minimumUpdatePeriodMs?: number;
  scan: DashScan;
  variants: VideoVariant[];
  audioTracks: AudioTrack[];
  /** Playlists by Representation@id, for the main track of each variant. */
  mainRepresentations: Map<string, MpdPlaylist>;
  /** Playlists by Representation@id, for each audio track. */
  audioRepresentations: Map<string, MpdPlaylist>;
}

const BOM = new RegExp('^\\uFEFF');

function runParser(text: string, url: string, now: number): MpdManifest {
  try {
    return parse(text, { manifestUri: url, NOW: now, eventHandler: () => undefined });
  } catch (error) {
    throw invalid(`Malformed MPD: ${errorMessage(error)}`);
  }
}

function bandwidthOf(playlist: MpdPlaylist): number {
  return nonNegativeInt(playlist.attributes?.BANDWIDTH) ?? 0;
}

function codecsOf(playlist: MpdPlaylist): string[] {
  const codecs = playlist.attributes?.CODECS;
  return splitCodecs(typeof codecs === 'string' ? codecs : undefined);
}

function toVariant(playlist: MpdPlaylist, index: number, representationId: string): VideoVariant {
  const codecs = codecsOf(playlist);
  const videoCodec = codecs.find((codec) => codecKind(codec) === 'video');
  const audioCodec = codecs.find((codec) => codecKind(codec) === 'audio');
  const height = nonNegativeInt(playlist.attributes?.RESOLUTION?.height);
  const variant: VideoVariant = {
    id: `video-${index}`,
    protocol: 'dash',
    codecs,
    audioOnly: height === undefined && videoCodec === undefined && codecs.length > 0,
    audioTrackIds: [],
    dash: { representationId },
  };
  const optional = {
    bandwidth: nonNegativeInt(playlist.attributes?.BANDWIDTH),
    width: nonNegativeInt(playlist.attributes?.RESOLUTION?.width),
    height,
    frameRate: positiveNumber(playlist.attributes?.['FRAME-RATE']),
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) variant[key as keyof typeof optional] = value;
  }
  if (videoCodec !== undefined) variant.videoCodec = videoCodec;
  if (audioCodec !== undefined) variant.audioCodec = audioCodec;
  return variant;
}

/**
 * Parses an MPD. `now` is the wall clock used for the segment window of
 * dynamic presentations.
 * @throws StreamGrabError MANIFEST_INVALID for anything that is not a usable MPD.
 */
export function parseMpd(text: string, url: string, now: number): ParsedMpd {
  const body = text.replace(BOM, '');
  const scan = scanDashManifest(body);
  if (!scan) throw invalid('Not a DASH MPD (root element is not <MPD>)');
  // MPDs never need a DTD; refusing one rules out entity-expansion tricks in the XML parser.
  if (/<!(?:DOCTYPE|ENTITY)/i.test(body)) throw invalid('MPDs with a document type declaration are not supported');
  const manifest = runParser(body, url, now);

  const mainRepresentations = new Map<string, MpdPlaylist>();
  const audioRepresentations = new Map<string, MpdPlaylist>();
  const variants: VideoVariant[] = [];
  for (const [index, playlist] of (manifest.playlists ?? []).entries()) {
    if (variants.length >= DASH_LIMITS.maxRepresentations) break;
    const representationId = nonEmptyString(playlist.attributes?.NAME, 256) ?? `representation-${index}`;
    // Several BaseURLs produce one copy of a representation per URL; keep the first.
    if (mainRepresentations.has(representationId)) continue;
    mainRepresentations.set(representationId, playlist);
    variants.push(toVariant(playlist, variants.length, representationId));
  }

  const audioTracks: AudioTrack[] = [];
  for (const members of Object.values(manifest.mediaGroups?.AUDIO ?? {})) {
    for (const [name, member] of Object.entries(members)) {
      if (audioTracks.length >= DASH_LIMITS.maxAudioTracks) break;
      // One track per adaptation set; use its highest-bandwidth representation.
      const best = [...(member.playlists ?? [])].sort((a, b) => bandwidthOf(b) - bandwidthOf(a))[0];
      if (!best) continue;
      const representationId = nonEmptyString(best.attributes?.NAME, 256) ?? `audio-representation-${audioTracks.length}`;
      audioRepresentations.set(representationId, best);
      const language = nonEmptyString(member.language, 35);
      const track: AudioTrack = {
        id: `audio-${audioTracks.length}`,
        name: nonEmptyString(name) ?? language ?? `Audio ${audioTracks.length + 1}`,
        isDefault: member.default === true,
        dash: { representationId },
      };
      if (language !== undefined) track.language = language;
      const codec = codecsOf(best).find((candidate) => codecKind(candidate) === 'audio') ?? codecsOf(best)[0];
      if (codec !== undefined) track.codec = codec;
      audioTracks.push(track);
    }
  }

  if (variants.length === 0) {
    // Audio-only presentation: each audio track is a selectable "variant".
    for (const track of audioTracks) {
      const representationId = track.dash?.representationId;
      const playlist = representationId === undefined ? undefined : audioRepresentations.get(representationId);
      if (!playlist || representationId === undefined) continue;
      mainRepresentations.set(representationId, playlist);
      variants.push({ ...toVariant(playlist, variants.length, representationId), audioOnly: true });
    }
    audioTracks.length = 0;
  }
  if (variants.length === 0) throw invalid('MPD contains no playable video or audio representations');
  for (const variant of variants) {
    variant.audioTrackIds = audioTracks.map((track) => track.id);
  }

  const parsed: ParsedMpd = {
    url,
    isLive: scan.live,
    scan,
    variants,
    audioTracks,
    mainRepresentations,
    audioRepresentations,
  };
  const duration = positiveNumber(manifest.duration);
  if (!scan.live && duration !== undefined) parsed.durationSec = duration;
  const minimumUpdatePeriodMs = nonNegativeInt(manifest.minimumUpdatePeriod);
  if (minimumUpdatePeriodMs !== undefined) parsed.minimumUpdatePeriodMs = minimumUpdatePeriodMs;
  return parsed;
}

/**
 * Ordered segments of one representation. A representation without a segment
 * list (SegmentBase: one indexed file, or a plain file) is returned as a
 * single resource: that file is a complete MP4 on its own.
 * @throws StreamGrabError MANIFEST_INVALID
 */
export function dashSegments(playlist: MpdPlaylist, mpdUrl: string, track: { id: string; type: TrackType }): MediaSegment[] {
  const builder = new SegmentListBuilder(track);
  const raw = Array.isArray(playlist.segments) ? playlist.segments : [];

  if (raw.length === 0) {
    const reference = playlist.sidx?.resolvedUri ?? playlist.sidx?.uri ?? playlist.resolvedUri ?? playlist.uri ?? '';
    const url = reference === '' ? null : resolveHttpUrl(reference, mpdUrl);
    if (url === null) throw invalid('Representation has neither segments nor a media file');
    builder.addMedia({
      url,
      duration: positiveNumber(playlist.targetDuration) ?? 0,
      discontinuity: 0,
      container: containerFromUrl(url, 'fmp4'),
    });
    return builder.segments;
  }
  if (raw.length > DASH_LIMITS.maxSegmentsPerRepresentation) {
    throw invalid(`Representation has ${raw.length} segments; the limit is ${DASH_LIMITS.maxSegmentsPerRepresentation}`);
  }

  let discontinuity = 0;
  let previousTimeline: number | undefined;
  raw.forEach((segment, i) => {
    const position = i + 1;
    // Period boundaries (timeline changes) are discontinuities: timestamps and init sections may change.
    const timeline = typeof segment.timeline === 'number' ? segment.timeline : previousTimeline;
    if (i > 0 && (segment.discontinuity === true || timeline !== previousTimeline)) discontinuity += 1;
    previousTimeline = timeline;

    const reference = segment.resolvedUri ?? segment.uri ?? '';
    const url = reference === '' ? null : resolveHttpUrl(reference, mpdUrl);
    if (url === null) throw invalid(`Segment ${position} has an unsupported URI`);
    const duration = segment.duration;
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) {
      throw invalid(`Segment ${position} has an invalid duration`);
    }

    if (segment.map) {
      const mapReference = segment.map.resolvedUri ?? segment.map.uri ?? '';
      const mapUrl = mapReference === '' ? null : resolveHttpUrl(mapReference, mpdUrl);
      if (mapUrl === null) throw invalid(`Initialization of segment ${position} has an unsupported URI`);
      const mapRange = toByteRange(segment.map.byterange, 'Initialization');
      const container = containerFromUrl(mapUrl, 'fmp4');
      builder.setInit(mapRange ? { url: mapUrl, byteRange: mapRange, container } : { url: mapUrl, container }, discontinuity);
    } else {
      builder.setInit(undefined, discontinuity);
    }

    const fields: MediaFields = { url, duration, discontinuity, container: containerFromUrl(url, 'fmp4') };
    const byteRange = toByteRange(segment.byterange, `Segment ${position}`);
    if (byteRange) fields.byteRange = byteRange;
    builder.addMedia(fields);
  });
  return builder.segments;
}
