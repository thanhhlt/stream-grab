import type { StoredBlob } from '@/core/download/download-storage';
import type { TrackLayout } from '@/core/models/media-info';
import { firstTimes, TIMESTAMP_HEAD_BYTES, timestampResets, tsSyncOffset, type FirstTimes } from './timestamps';

/** How far into a segment a disguising picture header is looked past. */
const DISGUISE_SEARCH_BYTES = 1024 * 1024;

/** Boxes an MP4 segment starts with: such a segment in a track declared MPEG-TS is never cut. */
const MP4_START_BOXES = new Set(['ftyp', 'styp', 'moof', 'moov', 'sidx', 'emsg', 'prft', 'free']);
const startsWithMp4Box = (head: Uint8Array): boolean =>
  head.length >= 8 && MP4_START_BOXES.has(String.fromCharCode(head[4] ?? 0, head[5] ?? 0, head[6] ?? 0, head[7] ?? 0));

/** The start of media other than MPEG-TS (MP4, WebM/Matroska, packed audio): never searched for MPEG-TS packets. */
function startsWithOtherMedia(head: Uint8Array): boolean {
  if (startsWithMp4Box(head)) return true;
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return true; // EBML
  if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return true; // ID3 (packed audio)
  return head[0] === 0xff && ((head[1] ?? 0) & 0xf6) === 0xf0; // ADTS
}

export interface PreparedTrack {
  /** Each segment's stored parts in order, ready for FFmpeg (references to the stored Blobs). */
  bySegment: Map<number, Blob[]>;
  /** Positions where timestamps go back without a discontinuity in the manifest (to start runs there). */
  resets: number[];
  /** Segments that carried bytes before their first MPEG-TS packet (diagnostics, tests). */
  stripped: number;
}

/**
 * A track's stored segments as FFmpeg should read them, from the first bytes
 * of each segment (nothing is copied):
 *
 * - MPEG-TS segments lose any bytes before their first packet. Some sites
 *   disguise segments as pictures: a ".png" name, and a small PNG (or GIF)
 *   before the video data. Players skip it; FFmpeg read such a track as a
 *   series of pictures, one per segment (750 segments at 25 pictures a
 *   second: "30 of 7407 seconds"), or found nothing in the part after a
 *   discontinuity. Segments named like neither (container "unknown") are
 *   recognised as MPEG-TS by their packets. The downloaded data is not changed.
 * - Timestamps that go back without a discontinuity in the manifest are found
 *   (timestamps.ts): always in fragmented MP4, whose jumps FFmpeg never
 *   corrects; in MPEG-TS when the track is joined from several runs, since
 *   FFmpeg corrects jumps in one MPEG-TS input but not inside concat runs.
 */
export async function prepareTrack(layout: TrackLayout, parts: readonly StoredBlob[], signal?: AbortSignal): Promise<PreparedTrack> {
  const bySegment = new Map<number, Blob[]>();
  for (const part of parts) {
    const list = bySegment.get(part.index) ?? [];
    list.push(part.data);
    bySegment.set(part.index, list);
  }
  // Segments the manifest calls MPEG-TS, and segments whose names say nothing about them (a ".png" disguise
  // leaves the container "unknown"): their bytes decide.
  const sniff = layout.container === 'mpeg-ts' || layout.container === 'unknown';
  if (!sniff && layout.container !== 'fmp4') return { bySegment, resets: [], stripped: 0 };

  const inits = new Set(layout.initIndexes);
  const segments: { position: number; times: FirstTimes }[] = [];
  let stripped = 0;
  let found = 0;
  for (let position = 0; position < layout.segments; position++) {
    const list = bySegment.get(position);
    const first = inits.has(position) ? undefined : list?.[0];
    if (!list || !first) continue;
    let head = new Uint8Array(await first.slice(0, TIMESTAMP_HEAD_BYTES).arrayBuffer());
    let container = layout.container;
    if (sniff && !startsWithOtherMedia(head)) {
      let offset = tsSyncOffset(head);
      // A larger picture in front: look further once.
      if (offset === undefined && first.size > head.length) {
        head = new Uint8Array(await first.slice(0, DISGUISE_SEARCH_BYTES).arrayBuffer());
        offset = tsSyncOffset(head);
      }
      if (offset !== undefined) {
        container = 'mpeg-ts';
        found += 1;
        if (offset > 0 && offset < first.size) {
          list[0] = first.slice(offset);
          head = head.subarray(offset);
          stripped += 1;
        }
      }
    }
    segments.push({ position, times: firstTimes(head, container) });
    signal?.throwIfAborted();
  }
  const ts = layout.container === 'mpeg-ts' || found > 0;
  const joined = layout.discontinuityIndexes.some((position) => position > 0) || layout.initIndexes.some((position) => position > 0);
  const resets = layout.container === 'fmp4' || (ts && joined) ? timestampResets(segments) : [];
  return { bySegment, resets, stripped };
}
