import type { SegmentStorage } from '@/core/download/download-storage';
import { buildLayout } from '@/core/download/track-layout';
import type { MediaSegment, TrackType } from '@/core/models/media-segment';
import type { AudioTrack } from '@/core/models/streaming-manifest';
import type { Rendition } from '@tests/fixtures/media/synthetic-media';

export interface StoredTrack {
  trackId: string;
  trackType: TrackType;
  rendition: Rendition;
  name?: string;
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
