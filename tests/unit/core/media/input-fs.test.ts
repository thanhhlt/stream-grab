import { describe, expect, it } from 'vitest';
import { inputPath } from '@/core/media/ffmpeg-job';
import { InputFs } from '@/core/media/input-fs';
import { parseProbeOutput, probeJob } from '@/core/media/probe';
import { FfmpegSession } from '@/core/media/ffmpeg-session';
import { SyncBlob } from '@tests/fakes/ffmpeg-node';
import { createNodeCore } from '@tests/fixtures/media/node-core';
import { syntheticMedia } from '@tests/fixtures/media/synthetic-media';

/** Reads SyncBlobs (Node has no FileReaderSync for real Blobs). */
const readSync = (blob: Blob) => (blob as unknown as SyncBlob).bytes.slice().buffer;

describe('InputFs', () => {
  it('serves FFmpeg’s small reads from large chunks, and yields the same bytes', async () => {
    const core = await createNodeCore();
    const inputs = new InputFs(core.FS, { chunkBytes: 64 * 1024, readSync });
    const data = new Uint8Array(1_000_000).map((_, i) => (i * 7) % 251);
    core.FS.mkdir('/mnt');
    core.FS.mount(inputs.type, { blobs: [{ name: 'a.bin', data: new SyncBlob(data) as unknown as Blob }] }, '/mnt');
    expect(core.FS.stat('/mnt/a.bin').size).toBe(1_000_000);
    expect(core.FS.readFile('/mnt/a.bin')).toEqual(data);
    // Emscripten read the file in pieces; the Blob was read once per 64 KiB chunk.
    expect(inputs.blobReads).toBe(Math.ceil(1_000_000 / (64 * 1024)));
    expect(() => {
      core.FS.writeFile('/mnt/b.bin', 'x');
    }).toThrow();
    core.FS.unmount('/mnt');
  });

  it('keeps a few chunks across inputs, as a merge reads video and audio in turn', async () => {
    const core = await createNodeCore();
    const inputs = new InputFs(core.FS, { chunkBytes: 1024, cachedChunks: 2, readSync });
    const blob = (byte: number) => new SyncBlob(new Uint8Array(4096).fill(byte)) as unknown as Blob;
    core.FS.mkdir('/mnt');
    core.FS.mount(inputs.type, { blobs: [{ name: 'v', data: blob(1) }, { name: 'a', data: blob(2) }] }, '/mnt');
    const video = core.FS.open('/mnt/v', 'r');
    const audio = core.FS.open('/mnt/a', 'r');
    const buffer = new Uint8Array(100);
    for (let i = 0; i < 10; i++) {
      core.FS.read(video, buffer, 0, 100, i * 100);
      expect(buffer[0]).toBe(1);
      core.FS.read(audio, buffer, 0, 100, i * 100);
      expect(buffer[0]).toBe(2);
    }
    // 1000 bytes of each, alternating: one chunk per input, not one read per call.
    expect(inputs.blobReads).toBe(2);
    core.FS.close(video);
    core.FS.close(audio);
    core.FS.unmount('/mnt');
  });

  it('is what the session mounts its inputs with', async () => {
    const media = await syntheticMedia();
    const session = new FfmpegSession(await createNodeCore(), { input: { chunkBytes: 8 * 1024, readSync } });
    const input = new SyncBlob(new Uint8Array(await new Blob(media.ts.muxed.segments).arrayBuffer())) as unknown as Blob;
    const probe = parseProbeOutput((await session.run(probeJob('in.ts', input))).stdout);
    expect(probe?.streams.map((stream) => stream.codec)).toEqual(['h264', 'aac']);
    expect(inputPath('in.ts')).toBe('/in/in.ts');
  });
});
