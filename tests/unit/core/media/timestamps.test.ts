import { beforeAll, describe, expect, it } from 'vitest';
import { firstTimes, TIMESTAMP_HEAD_BYTES, timestampResets, tsSyncOffset } from '@/core/media/timestamps';
import { syntheticMedia, type Rendition, type SyntheticMedia } from '@tests/fixtures/media/synthetic-media';

let media: SyntheticMedia;
beforeAll(async () => {
  media = await syntheticMedia();
}, 60_000);

const head = (bytes: Uint8Array) => bytes.subarray(0, TIMESTAMP_HEAD_BYTES);

/** One MPEG-TS packet carrying the start of a PES with this PTS (and DTS). */
function pesPacket(pid: number, pts: number, dts?: number): Uint8Array {
  const packet = new Uint8Array(188).fill(0xff);
  packet.set([0x47, 0x40 | (pid >> 8), pid & 0xff, 0x10]);
  const encode = (marker: number, value: number) => {
    const high = Math.floor(value / 2 ** 30) & 0x07;
    const low = value % 2 ** 30;
    return [(marker << 4) | (high << 1) | 1, (low >> 22) & 0xff, (((low >> 15) & 0x7f) << 1) | 1, (low >> 7) & 0xff, ((low & 0x7f) << 1) | 1];
  };
  const flags = dts === undefined ? 0x80 : 0xc0;
  const fields = dts === undefined ? encode(0x2, pts) : [...encode(0x3, pts), ...encode(0x1, dts)];
  packet.set([0, 0, 1, 0xe0, 0, 0, 0x80, flags, fields.length, ...fields], 4);
  return packet;
}

function box(type: string, ...content: (Uint8Array | number[])[]): Uint8Array {
  const body = content.flatMap((part) => [...part]);
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set([...type].map((char) => char.charCodeAt(0)), 4);
  out.set(body, 8);
  return out;
}

const u32 = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];

describe('firstTimes', () => {
  it('reads the first timestamp of each MPEG-TS stream, increasing from segment to segment', () => {
    const v = media.ts.video['v180'] as Rendition;
    const times = v.segments.map((segment) => firstTimes(head(segment), 'mpeg-ts'));
    expect(times.every((map) => map.size === 1)).toBe(true);
    const values = times.map((map) => [...map.values()][0] ?? 0);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    // 2-second segments on the 90 kHz clock.
    expect((values[1] ?? 0) - (values[0] ?? 0)).toBeCloseTo(180_000, -3);
    expect([...firstTimes(head(media.ts.muxed.segments[0] as Uint8Array), 'mpeg-ts').keys()]).toHaveLength(2); // video and audio PIDs
  });

  it('prefers the DTS, reads all 33 bits, and skips junk before the first packet', () => {
    const late = 2 ** 33 - 90_000; // one second before the clock wraps
    const bytes = new Uint8Array([...new Uint8Array(37).fill(0x89), ...pesPacket(0x100, late + 3003, late), ...pesPacket(0x101, 1234)]);
    expect(firstTimes(bytes, 'mpeg-ts')).toEqual(new Map([[0x100, late], [0x101, 1234]]));
  });

  it("reads each track fragment's tfdt in fragmented MP4 (32 and 64 bits), after styp/sidx", () => {
    const v = media.fmp4.video['v180'] as Rendition;
    const values = v.segments.map((segment) => [...firstTimes(head(segment), 'fmp4').values()][0]);
    expect(values.every((value) => value !== undefined)).toBe(true);
    expect(values).toEqual([...values].sort((a, b) => (a ?? 0) - (b ?? 0)));

    const traf = (trackId: number, tfdt: Uint8Array) => box('traf', box('tfhd', [0, 0, 0, 0], u32(trackId)), tfdt);
    const fragment = new Uint8Array([
      ...box('styp', [0x6d, 0x73, 0x64, 0x68]),
      ...box('sidx', new Uint8Array(24)),
      ...box('moof', box('mfhd', new Uint8Array(8)), traf(1, box('tfdt', [1, 0, 0, 0], u32(3), u32(5))), traf(2, box('tfdt', [0, 0, 0, 0], u32(48_000)))),
      ...box('mdat', new Uint8Array(16)),
    ]);
    expect(firstTimes(fragment, 'fmp4')).toEqual(new Map([[1, 3 * 2 ** 32 + 5], [2, 48_000]]));
  });

  it('finds nothing in other containers or unreadable data', () => {
    expect(firstTimes(new Uint8Array(1000), 'mpeg-ts').size).toBe(0);
    expect(firstTimes(new Uint8Array([1, 2, 3]), 'fmp4').size).toBe(0);
    expect(firstTimes(media.ts.audio.segments[0] as Uint8Array, 'webm').size).toBe(0);
  });
});

describe('tsSyncOffset', () => {
  it('finds the first MPEG-TS packet after a picture header, and nothing in data without packets', () => {
    const segment = media.ts.muxed.segments[0] as Uint8Array;
    expect(tsSyncOffset(segment)).toBe(0);
    // A PNG signature contains no 0x47 followed by others 188 bytes apart; a stray 0x47 in the picture is not a start.
    const picture = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Uint8Array(400).fill(0x47).map((_, i) => (i % 7 === 0 ? 0x47 : 0x11))]);
    const disguised = new Uint8Array([...picture, ...segment.subarray(0, 4096)]);
    expect(tsSyncOffset(disguised)).toBe(picture.length);
    expect(tsSyncOffset(new Uint8Array(1000))).toBeUndefined();
    expect(tsSyncOffset(new Uint8Array([0x47, 1, 2]))).toBe(0); // too short to confirm: only a start at 0 counts
  });
});

describe('timestampResets', () => {
  const at = (position: number, ...entries: [number, number][]) => ({ position, times: new Map(entries) });

  it('reports segments that start no later than the previous one, per stream', () => {
    expect(
      timestampResets([
        at(0, [1, 100]),
        at(1, [1, 200]),
        at(2, [1, 50]), // went back
        at(3), // nothing readable: skipped
        at(4, [1, 60]),
        at(5, [2, 10]), // another stream: nothing to compare
        at(6, [2, 10]), // same start again
      ]),
    ).toEqual([2, 6]);
    expect(timestampResets([])).toEqual([]);
  });
});
