import { beforeAll, describe, expect, it } from 'vitest';
import { inputPath, outputPath } from '@/core/media/ffmpeg-job';
import { BlobSink, SinkAccessError } from '@/core/media/output-sink';
import { loadNodeSession, SyncBlob, syncBlob } from '@tests/fakes/ffmpeg-node';
import { createNodeCore } from '@tests/fixtures/media/node-core';
import { syntheticMedia, type SyntheticMedia } from '@tests/fixtures/media/synthetic-media';

const bytes = (...values: number[]) => new Uint8Array(values);
const text = async (blob: Blob) => [...new Uint8Array(await blob.arrayBuffer())];

describe('BlobSink', () => {
  const small = () => new BlobSink({ headBytes: 4, windowBytes: 8, flushBytes: 4 });

  it('streams sequential writes into parts, keeping only the head and a window', async () => {
    const sink = small();
    for (let i = 0; i < 30; i++) sink.write(bytes(i), i);
    expect(sink.size).toBe(30);
    expect(sink.bufferedBytes).toBeLessThanOrEqual(4 + 12);
    expect(await text(sink.toBlob())).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });

  it('lets the muxer patch the head and the recent window, but not flushed data', async () => {
    const sink = small();
    sink.write(new Uint8Array(30).fill(1), 0);
    sink.write(bytes(9, 9), 1); // MP4 mdat size / Matroska segment size
    sink.write(bytes(7), 27); // recent: still in the window
    expect(() => sink.write(bytes(5), 10)).toThrow(SinkAccessError);
    expect(sink.failure).toBeInstanceOf(SinkAccessError);
    const all = await text(sink.toBlob());
    expect(all.slice(0, 4)).toEqual([1, 9, 9, 1]);
    expect(all[27]).toBe(7);
    expect(all[10]).toBe(1);
  });

  it('reads back what is in memory, zero-fills gaps, and truncates', async () => {
    const sink = small();
    sink.write(bytes(1, 2), 6); // a gap: bytes 0–5 are zeros
    const target = new Uint8Array(8);
    expect(sink.read(target, 0)).toBe(8);
    expect([...target]).toEqual([0, 0, 0, 0, 0, 0, 1, 2]);
    expect(sink.read(new Uint8Array(4), 7)).toBe(1); // end of file
    sink.truncate(0);
    expect(sink.size).toBe(0);
    sink.write(bytes(3), 0);
    expect(await text(sink.toBlob())).toEqual([3]);
  });
});

describe('SinkFs with the real FFmpeg', () => {
  let media: SyntheticMedia;
  beforeAll(async () => {
    media = await syntheticMedia();
  }, 60_000);

  /** The same remux written to MEMFS by the plain core: the reference bytes. */
  async function reference(format: 'mp4' | 'matroska', input: Uint8Array): Promise<Uint8Array> {
    const core = await createNodeCore();
    core.FS.mkdir('/ref');
    core.FS.writeFile('/ref/in.ts', input);
    expect(core.exec('-hide_banner', '-loglevel', 'error', '-i', '/ref/in.ts', '-c', 'copy', '-fflags', '+bitexact', '-f', format, '/ref/out')).toBe(0);
    return core.FS.readFile('/ref/out');
  }

  it.each(['mp4', 'matroska'] as const)('writes %s byte for byte like MEMFS, with a window far smaller than the file', async (format) => {
    const track = media.ts.muxed;
    const input = new Uint8Array(await new Blob(track.segments).arrayBuffer());
    // 4 KiB head, 16 KiB window: the file is flushed many times while FFmpeg writes it.
    const session = await loadNodeSession({ sink: { headBytes: 4096, windowBytes: 16384, flushBytes: 8192 } });
    const result = session.run({
      tool: 'ffmpeg',
      // bitexact: Matroska otherwise writes a random segment UID.
      args: ['-hide_banner', '-i', inputPath('in.ts'), '-c', 'copy', '-fflags', '+bitexact', '-f', format, outputPath('out')],
      inputs: [{ name: 'in.ts', data: new SyncBlob(input) as unknown as Blob }],
      outputs: ['out'],
    });
    expect(result.exitCode).toBe(0);
    const streamed = new Uint8Array(await (result.outputs[0]?.data ?? new Blob()).arrayBuffer());
    expect(streamed.length).toBeGreaterThan(16384 * 4);
    const expected = await reference(format, input);
    expect(streamed.length).toBe(expected.length);
    const firstDifference = streamed.findIndex((byte, i) => byte !== expected[i]);
    expect(firstDifference).toBe(-1);
  });

  it('fails instead of handing over a damaged file when a format reads its output back (MP4 faststart)', async () => {
    const session = await loadNodeSession({ sink: { headBytes: 4096, windowBytes: 16384, flushBytes: 8192 } });
    const input = await syncBlob(new Blob(media.ts.muxed.segments));
    expect(() =>
      session.run({
        tool: 'ffmpeg',
        args: ['-hide_banner', '-i', inputPath('in.ts'), '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', outputPath('out.mp4')],
        inputs: [{ name: 'in.ts', data: input }],
        outputs: ['out.mp4'],
      }),
    ).toThrow(/already been written out/);
    expect(session.usable).toBe(true);
  });
});
