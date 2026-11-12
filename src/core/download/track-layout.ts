import type { TrackLayout } from '@/core/models/media-info';
import { TRACK_TYPES, type ContainerFormat, type MediaSegment } from '@/core/models/media-segment';
import type { AudioTrack } from '@/core/models/streaming-manifest';
import { isOneOf, isRecord } from '@/shared/utils/guards';

const CONTAINERS: readonly ContainerFormat[] = ['mpeg-ts', 'fmp4', 'webm', 'packed-audio', 'webvtt', 'unknown'];
const MAX_TRACKS = 32;
const MAX_POSITIONS = 1_000_000;

/**
 * The layout of a download's segment list, per track, in the order tracks
 * first appear (the variant's own track first). Built after single files were
 * split into ranged chunks, so positions match what storage holds.
 */
export function buildLayout(segments: readonly MediaSegment[], audioTracks: readonly AudioTrack[] = []): TrackLayout[] {
  const tracks = new Map<string, TrackLayout & { lastDiscontinuity: number | undefined }>();
  for (const segment of segments) {
    let track = tracks.get(segment.trackId);
    if (!track) {
      track = {
        trackId: segment.trackId,
        trackType: segment.trackType,
        segments: 0,
        initIndexes: [],
        discontinuityIndexes: [],
        container: 'unknown',
        durationSec: 0,
        lastDiscontinuity: undefined,
      };
      const audio = audioTracks.find((candidate) => candidate.id === segment.trackId);
      if (audio) {
        track.name = audio.name;
        if (audio.language !== undefined) track.language = audio.language;
      }
      tracks.set(segment.trackId, track);
    }
    track.segments = Math.max(track.segments, segment.index + 1);
    if (segment.kind === 'init') {
      track.initIndexes.push(segment.index);
    } else {
      if (track.container === 'unknown') track.container = segment.container;
      track.durationSec += segment.duration;
    }
    if (track.lastDiscontinuity !== undefined && segment.discontinuity !== track.lastDiscontinuity) {
      track.discontinuityIndexes.push(segment.index);
    }
    track.lastDiscontinuity = segment.discontinuity;
  }
  return [...tracks.values()].map(({ lastDiscontinuity: _last, ...track }) => ({
    ...track,
    durationSec: Math.round(track.durationSec * 1000) / 1000,
  }));
}

function positions(raw: unknown, segments: number): number[] | null {
  if (!Array.isArray(raw) || raw.length > Math.min(segments, MAX_POSITIONS)) return null;
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= segments) return null;
  }
  return raw as number[];
}

/** Validates a layout read back from IndexedDB; null when it is missing or damaged (the task re-plans). */
export function parseLayout(raw: unknown): TrackLayout[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TRACKS) return null;
  const tracks: TrackLayout[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return null;
    const { trackId, trackType, segments, container, durationSec } = item;
    if (typeof trackId !== 'string' || trackId.length === 0 || trackId.length > 64) return null;
    if (!isOneOf(trackType, TRACK_TYPES) || !isOneOf(container, CONTAINERS)) return null;
    if (typeof segments !== 'number' || !Number.isInteger(segments) || segments < 1 || segments > MAX_POSITIONS) return null;
    if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec < 0) return null;
    const initIndexes = positions(item['initIndexes'], segments);
    const discontinuityIndexes = positions(item['discontinuityIndexes'], segments);
    if (!initIndexes || !discontinuityIndexes) return null;
    const track: TrackLayout = { trackId, trackType, segments, initIndexes, discontinuityIndexes, container, durationSec };
    if (typeof item['name'] === 'string' && item['name'].length <= 200) track.name = item['name'];
    if (typeof item['language'] === 'string' && item['language'].length <= 35) track.language = item['language'];
    tracks.push(track);
  }
  return tracks;
}

export function sameLayout(a: readonly TrackLayout[] | undefined, b: readonly TrackLayout[]): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}
