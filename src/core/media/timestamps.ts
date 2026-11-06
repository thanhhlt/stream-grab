import type { ContainerFormat } from '@/core/models/media-segment';

/**
 * Where a track's timestamps go back between two segments without the
 * manifest saying so (no EXT-X-DISCONTINUITY / Period boundary): an intro or
 * ad packaged on its own timeline, parts of a video stitched together, a
 * 33-bit MPEG-TS clock wrap. Merging such data as one run makes FFmpeg keep
 * decode times increasing by clamping them, so everything after the jump is
 * squeezed onto its end: a two-hour video comes out a few seconds long. Cut
 * there, each piece becomes its own run, which the concat demuxer places
 * after the previous one in time.
 *
 * Pure: reads the first decode time of a segment from its first bytes
 * (MPEG-TS: the first PES header of each PID; fragmented MP4: each track
 * fragment's `tfdt`). Other containers are not inspected.
 */

/** Bytes of a segment's start that hold its first timestamps (PAT/PMT and the first PES, or styp/sidx/moof). */
export const TIMESTAMP_HEAD_BYTES = 64 * 1024;

const TS_PACKET = 188;

/** First decode time of each elementary stream (PID or track_ID) found in the bytes, in the stream's own units. */
export type FirstTimes = Map<number, number>;

function tsTimestamp(bytes: Uint8Array, at: number): number {
  const b0 = bytes[at] ?? 0;
  const b1 = bytes[at + 1] ?? 0;
  const b2 = bytes[at + 2] ?? 0;
  const b3 = bytes[at + 3] ?? 0;
  const b4 = bytes[at + 4] ?? 0;
  // 33 bits: more than Uint32 arithmetic holds, so multiply instead of shifting the top bits.
  return ((b0 >> 1) & 0x07) * 2 ** 30 + ((b1 << 22) | ((b2 >> 1) << 15) | (b3 << 7) | (b4 >> 1));
}

/**
 * Offset of the first MPEG-TS packet: a sync byte (0x47) repeated 188 bytes
 * later (three in a row when the data is long enough). Some sites disguise
 * segments as pictures, with a PNG or GIF header before the video data;
 * players skip it, FFmpeg takes the file for a picture. Undefined when no
 * packet is found.
 */
export function tsSyncOffset(bytes: Uint8Array): number | undefined {
  for (let at = 0; at < bytes.length; at++) {
    if (bytes[at] !== 0x47) continue;
    if (at + TS_PACKET >= bytes.length) return at === 0 ? 0 : undefined; // too short to confirm a later start
    if (bytes[at + TS_PACKET] !== 0x47) continue;
    if (at + 2 * TS_PACKET < bytes.length && bytes[at + 2 * TS_PACKET] !== 0x47) continue;
    return at;
  }
  return undefined;
}

/** MPEG-TS: the DTS (or PTS) of the first PES of each audio/video PID. */
function tsFirstTimes(bytes: Uint8Array): FirstTimes {
  const times: FirstTimes = new Map();
  const start = tsSyncOffset(bytes);
  if (start === undefined) return times;
  for (let packet = start; packet + TS_PACKET <= bytes.length; packet += TS_PACKET) {
    if (bytes[packet] !== 0x47) break;
    const b1 = bytes[packet + 1] ?? 0;
    if ((b1 & 0x40) === 0) continue; // not the start of a payload unit
    const pid = ((b1 & 0x1f) << 8) | (bytes[packet + 2] ?? 0);
    if (times.has(pid)) continue;
    const control = ((bytes[packet + 3] ?? 0) >> 4) & 0x03;
    if (control === 0 || control === 2) continue; // no payload
    const payload = packet + 4 + (control === 3 ? 1 + (bytes[packet + 4] ?? 0) : 0);
    if (payload + 14 > packet + TS_PACKET) continue;
    if (bytes[payload] !== 0 || bytes[payload + 1] !== 0 || bytes[payload + 2] !== 1) continue; // not a PES
    const streamId = bytes[payload + 3] ?? 0;
    const media = (streamId >= 0xc0 && streamId <= 0xef) || streamId === 0xbd; // audio, video, private stream 1 (AC-3)
    if (!media) continue;
    const flags = ((bytes[payload + 7] ?? 0) >> 6) & 0x03;
    if (flags === 2) times.set(pid, tsTimestamp(bytes, payload + 9));
    else if (flags === 3 && payload + 19 <= packet + TS_PACKET) times.set(pid, tsTimestamp(bytes, payload + 14));
  }
  return times;
}

function boxAt(bytes: Uint8Array, view: DataView, at: number, end: number): { type: string; start: number; end: number } | undefined {
  if (at + 8 > end) return undefined;
  let size = view.getUint32(at);
  let header = 8;
  if (size === 1) {
    if (at + 16 > end) return undefined;
    size = view.getUint32(at + 8) * 2 ** 32 + view.getUint32(at + 12);
    header = 16;
  } else if (size === 0) {
    size = end - at;
  }
  if (size < header) return undefined;
  const type = String.fromCharCode(bytes[at + 4] ?? 0, bytes[at + 5] ?? 0, bytes[at + 6] ?? 0, bytes[at + 7] ?? 0);
  return { type, start: at + header, end: Math.min(at + size, end) };
}

/** Fragmented MP4: the base media decode time (`tfdt`) of each track fragment of the first `moof`. */
function fmp4FirstTimes(bytes: Uint8Array): FirstTimes {
  const times: FirstTimes = new Map();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0, box = boxAt(bytes, view, 0, bytes.length); box; at = box.end, box = boxAt(bytes, view, at, bytes.length)) {
    if (box.end <= at) break;
    if (box.type !== 'moof') continue;
    for (let child = boxAt(bytes, view, box.start, box.end); child; child = boxAt(bytes, view, child.end, box.end)) {
      if (child.type === 'traf') {
        let trackId: number | undefined;
        let time: number | undefined;
        for (let inner = boxAt(bytes, view, child.start, child.end); inner; inner = boxAt(bytes, view, inner.end, child.end)) {
          if (inner.type === 'tfhd' && inner.start + 8 <= inner.end) trackId = view.getUint32(inner.start + 4);
          if (inner.type === 'tfdt' && inner.start + 8 <= inner.end) {
            const version = bytes[inner.start] ?? 0;
            if (version === 1 && inner.start + 12 <= inner.end) time = view.getUint32(inner.start + 4) * 2 ** 32 + view.getUint32(inner.start + 8);
            else time = view.getUint32(inner.start + 4);
          }
          if (inner.end <= inner.start) break;
        }
        if (trackId !== undefined && time !== undefined && !times.has(trackId)) times.set(trackId, time);
      }
      if (child.end <= child.start) break;
    }
    break; // the first fragment is enough
  }
  return times;
}

/** The first decode times in a segment's first bytes; empty when the container is not inspected or nothing was found. */
export function firstTimes(head: Uint8Array, container: ContainerFormat): FirstTimes {
  if (container === 'mpeg-ts') return tsFirstTimes(head);
  if (container === 'fmp4') return fmp4FirstTimes(head);
  return new Map();
}

/**
 * Positions (in a track's segment list) whose first decode time is not after
 * the previous media segment's, for a stream both segments carry. Segments
 * without timestamps (init segments, unreadable heads) are skipped.
 */
export function timestampResets(segments: readonly { position: number; times: FirstTimes }[]): number[] {
  const resets: number[] = [];
  let previous: FirstTimes | undefined;
  for (const { position, times } of segments) {
    if (times.size === 0) continue;
    if (previous) {
      const before = previous;
      if ([...times].some(([stream, time]) => before.has(stream) && time <= (before.get(stream) ?? 0))) resets.push(position);
    }
    previous = times;
  }
  return resets;
}
