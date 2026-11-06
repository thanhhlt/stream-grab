import { beforeAll, describe, expect, it } from 'vitest';
import { FfmpegError, inputPath, outputPath, type FfmpegJob } from '@/core/media/ffmpeg-job';
import { FfmpegSession } from '@/core/media/ffmpeg-session';
import { parseProbeOutput, probeJob } from '@/core/media/probe';
import { loadNodeSession, syncBlob } from '@tests/fakes/ffmpeg-node';
import { createNodeCore } from '@tests/fixtures/media/node-core';
import { syntheticMedia, type SyntheticMedia } from '@tests/fixtures/media/synthetic-media';

/**
 * FfmpegSession on the real FFmpeg.wasm core (the file the extension ships):
 * WORKERFS inputs, commands, chunked output collection, cleanup and failure
 * handling. Only the thread is missing (the media worker adds it).
 */

let media: SyntheticMedia;
let session: FfmpegSession;

beforeAll(async () => {
  media = await syntheticMedia();
  session = await loadNodeSession({ sink: { headBytes: 4096, windowBytes: 8192, flushBytes: 4096 } });
}, 60_000);

const tsTrack = async (): Promise<Blob> => syncBlob(new Blob(media.ts.muxed.segments));

describe('FfmpegSession', () => {
  it('probes a mounted Blob without copying it into the heap', async () => {
    const result = session.run(probeJob('track-1.ts', await tsTrack()));
    expect(result.exitCode).toBeUndefined(); // ffprobe reports through its output only
    const probe = parseProbeOutput(result.stdout);
    expect(probe?.format).toBe('mpegts');
    expect(probe?.streams).toEqual([
      expect.objectContaining({ kind: 'video', codec: 'h264', width: 320, height: 180, frameRate: 10 }),
      expect.objectContaining({ kind: 'audio', codec: 'aac', channels: 2, sampleRate: 48000 }),
    ]);
    expect(probe?.durationSec).toBeCloseTo(8, 0);
  });

  it('remuxes by stream copy, returns the output as a Blob read in chunks, and cleans up', async () => {
    const progress: number[] = [];
    const job: FfmpegJob = {
      tool: 'ffmpeg',
      args: ['-hide_banner', '-i', inputPath('in.ts'), '-c', 'copy', '-f', 'mp4', outputPath('out.mp4')],
      inputs: [{ name: 'in.ts', data: await tsTrack() }],
      outputs: ['out.mp4'],
    };
    const result = session.run(job, { onProgress: (seconds) => progress.push(seconds) });
    expect(result.exitCode).toBe(0);
    const output = result.outputs[0];
    expect(output?.name).toBe('out.mp4');
    const bytes = new Uint8Array(await (output?.data ?? new Blob()).arrayBuffer());
    expect(bytes.length).toBeGreaterThan(8192); // streamed through the sink's window in several parts
    expect(new TextDecoder().decode(bytes.subarray(4, 8))).toBe('ftyp');
    expect(progress.at(-1)).toBeGreaterThan(7);

    // The MP4 FFmpeg wrote is readable media, every chunk in place.
    const reprobe = parseProbeOutput(session.run(probeJob('out.mp4', await syncBlob(new Blob([bytes])))).stdout);
    expect(reprobe?.format).toContain('mp4');
    expect(reprobe?.streams.map((stream) => stream.codec)).toEqual(['h264', 'aac']);
  });

  it('reports a failing command as a result and stays usable', async () => {
    const junk = await syncBlob(new Blob([new Uint8Array(5000).fill(0x42)]));
    const result = session.run({
      tool: 'ffmpeg',
      args: ['-hide_banner', '-i', inputPath('junk.ts'), '-c', 'copy', outputPath('out.mp4')],
      inputs: [{ name: 'junk.ts', data: junk }],
      outputs: ['out.mp4'],
    });
    expect(result.exitCode).toBe(1);
    expect(result.outputs).toEqual([]);
    expect(result.stderrTail.join('\n')).toContain('Invalid data found when processing input');
    expect(session.usable).toBe(true);
    expect(parseProbeOutput(session.run(probeJob('again.ts', await tsTrack())).stdout)?.format).toBe('mpegts');
  });

  it('refuses invalid jobs without touching FFmpeg', () => {
    const data = new Blob(['x']);
    const invalid = (job: FfmpegJob) => () => session.run(job);
    expect(invalid({ tool: 'ffprobe', args: ['-i', 'x'], inputs: [{ name: '../etc', data }], outputs: [] })).toThrow(FfmpegError);
    expect(invalid({ tool: 'ffprobe', args: ['-i', 'x'], inputs: [{ name: 'a', data }, { name: 'a', data }], outputs: [] })).toThrow(/duplicate/);
    expect(invalid({ tool: 'ffmpeg', args: [], inputs: [], outputs: [] })).toThrow(/arguments/);
    expect(session.usable).toBe(true);
  });
});

describe('FfmpegSession failures', () => {
  it('turns a WebAssembly crash into an error and refuses further commands', async () => {
    const core = await createNodeCore();
    core.exec = () => {
      throw new WebAssembly.RuntimeError('null function or function signature mismatch');
    };
    const broken = new FfmpegSession(core);
    const job: FfmpegJob = { tool: 'ffmpeg', args: ['-version'], inputs: [], outputs: [] };
    expect(() => broken.run(job)).toThrow(expect.objectContaining({ kind: 'crashed' }) as Error);
    expect(broken.usable).toBe(false);
    expect(() => broken.run(job)).toThrow(/earlier error/);
  });

  it('recognises running out of memory', async () => {
    const core = await createNodeCore();
    const oom = new FfmpegSession(core);
    core.exec = () => {
      oom.aborted('OOM'); // what the core's onAbort reports
      return 1;
    };
    expect(() => oom.run({ tool: 'ffmpeg', args: ['-version'], inputs: [], outputs: [] })).toThrow(
      expect.objectContaining({ kind: 'memory', message: expect.stringContaining('ran out of memory') as string }) as Error,
    );

    const core2 = await createNodeCore();
    core2.exec = () => {
      throw new RangeError('WebAssembly.Memory.grow(): Maximum memory size exceeded');
    };
    expect(() => new FfmpegSession(core2).run({ tool: 'ffmpeg', args: ['-version'], inputs: [], outputs: [] })).toThrow(
      expect.objectContaining({ kind: 'memory' }) as Error,
    );
  });
});
