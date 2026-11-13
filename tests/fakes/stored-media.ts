import type { SegmentStorage } from '@/core/download/download-storage';
import { buildLayout } from '@/core/download/track-layout';
import type { ContainerFormat, MediaSegment, TrackType } from '@/core/models/media-segment';
import type { AudioTrack, SubtitleTrack } from '@/core/models/streaming-manifest';
import type { Rendition } from '@tests/fixtures/media/synthetic-media';

export interface StoredTrack {
  trackId: string;
  trackType: TrackType;
  rendition: Rendition;
  name?: string;
}

export interface StoredSegmentSpec {
  body: Uint8Array<ArrayBuffer>;
  /** Seconds (0 for an init segment). */
  duration: number;
  init?: boolean;
  /** The manifest's discontinuity counter (EXT-X-DISCONTINUITY / Period). */
  discontinuity?: number;
}

/**
 * Like storeDownloadedTask, for segment lists a test lays out itself:
 * repeated segments (timestamps that go back), discontinuity counters,
 * initialization segments in the middle.
 */
export async function storeSegments(
  storage: SegmentStorage,
  taskId: string,
  tracks: readonly {
    trackId: string;
    trackType: TrackType;
    container: ContainerFormat;
    segments: readonly StoredSegmentSpec[];
    name?: string;
    /** Subtitle tracks: the manifest's language (with `name`). */
    language?: string;
    /** Subtitle tracks (0.7.2): a page subtitle file (with `name`). */
    pageFile?: true;
    /** A page subtitle file: how far its player moves the cues. */
    offsetSec?: number;
  }[],
): Promise<void> {
  const segments: MediaSegment[] = [];
  const audioTracks: AudioTrack[] = [];
  const subtitleTracks: SubtitleTrack[] = [];
  for (const track of tracks) {
    if (track.name !== undefined && track.trackType === 'subtitle') {
      subtitleTracks.push({
        id: track.trackId,
        name: track.name,
        ...(track.language !== undefined ? { language: track.language } : {}),
        isDefault: false,
        forced: false,
        ...(track.pageFile ? { pageFile: true as const } : {}),
        ...(track.offsetSec !== undefined ? { offsetSec: track.offsetSec } : {}),
      });
    } else if (track.name !== undefined) audioTracks.push({ id: track.trackId, name: track.name, language: 'en', isDefault: true });
    for (const [index, spec] of track.segments.entries()) {
      segments.push({
        id: `${track.trackId}:${index}`,
        trackId: track.trackId,
        trackType: track.trackType,
        index,
        kind: spec.init ? 'init' : 'media',
        url: `https://cdn.example.com/${track.trackId}/${index}`,
        duration: spec.duration,
        discontinuity: spec.discontinuity ?? 0,
        container: track.container,
      });
      await storage.put({ taskId, trackId: track.trackId, index, part: 0 }, new Blob([spec.body]));
      await storage.completeSegment({ taskId, trackId: track.trackId, index, bytes: spec.body.length, parts: 1 });
    }
  }
  await storage.savePlan({ taskId, signature: `test-${segments.length}`, segmentsTotal: segments.length, updatedAt: 1, layout: buildLayout(segments, audioTracks, subtitleTracks) });
}

/**
 * Writes renditions into segment storage exactly as a finished download
 * leaves them: init segment first, one part per segment, completion markers,
 * and the plan with its track layout. Returns the segment list.
 */
export async function storeDownloadedTask(storage: SegmentStorage, taskId: string, tracks: readonly StoredTrack[]): Promise<MediaSegment[]> {
  const segments: MediaSegment[] = [];
  const audioTracks: AudioTrack[] = [];
  for (const track of tracks) {
    if (track.name !== undefined) audioTracks.push({ id: track.trackId, name: track.name, language: 'en', isDefault: true });
    const container = track.rendition.init ? 'fmp4' : 'mpeg-ts';
    const bodies = [...(track.rendition.init ? [track.rendition.init] : []), ...track.rendition.segments];
    bodies.forEach((_, index) => {
      const isInit = track.rendition.init !== undefined && index === 0;
      segments.push({
        id: `${track.trackId}:${index}`,
        trackId: track.trackId,
        trackType: track.trackType,
        index,
        kind: isInit ? 'init' : 'media',
        url: `https://cdn.example.com/${track.trackId}/${index}`,
        duration: isInit ? 0 : (track.rendition.durations[index - (track.rendition.init ? 1 : 0)] ?? 0),
        discontinuity: 0,
        container,
      });
    });
    for (const [index, body] of bodies.entries()) {
      await storage.put({ taskId, trackId: track.trackId, index, part: 0 }, new Blob([body]));
      await storage.completeSegment({ taskId, trackId: track.trackId, index, bytes: body.length, parts: 1 });
    }
  }
  await storage.savePlan({ taskId, signature: `test-${segments.length}`, segmentsTotal: segments.length, updatedAt: 1, layout: buildLayout(segments, audioTracks) });
  return segments;
}
