import { beforeAll, describe, expect, it } from 'vitest';
import { FfmpegError, inputPath, outputPath, type FfmpegJob } from '@/core/media/ffmpeg-job';
import { FfmpegSession } from '@/core/media/ffmpeg-session';
import { parseProbeOutput, probeJob } from '@/core/media/probe';
import { loadNodeSession, syncBlob } from '@tests/fakes/ffmpeg-node';
import { MemoryOutputFiles } from '@tests/fakes/output-files';
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
    const result = await session.run(probeJob('track-1.ts', await tsTrack()));
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
    const result = await session.run(job, { onProgress: (seconds) => progress.push(seconds) });
    expect(result.exitCode).toBe(0);
    const output = result.outputs[0];
    expect(output?.name).toBe('out.mp4');
    const bytes = new Uint8Array(await (output?.data ?? new Blob()).arrayBuffer());
    expect(bytes.length).toBeGreaterThan(8192); // streamed through the sink's window in several parts
    expect(new TextDecoder().decode(bytes.subarray(4, 8))).toBe('ftyp');
    expect(progress.at(-1)).toBeGreaterThan(7);

    // The MP4 FFmpeg wrote is readable media, every chunk in place.
    const reprobe = parseProbeOutput((await session.run(probeJob('out.mp4', await syncBlob(new Blob([bytes]))))).stdout);
    expect(reprobe?.format).toContain('mp4');
    expect(reprobe?.streams.map((stream) => stream.codec)).toEqual(['h264', 'aac']);
  });

  it('reports a failing command as a result and stays usable', async () => {
    const junk = await syncBlob(new Blob([new Uint8Array(5000).fill(0x42)]));
    const result = await session.run({
      tool: 'ffmpeg',
      args: ['-hide_banner', '-i', inputPath('junk.ts'), '-c', 'copy', outputPath('out.mp4')],
      inputs: [{ name: 'junk.ts', data: junk }],
      outputs: ['out.mp4'],
    });
    expect(result.exitCode).toBe(1);
    expect(result.outputs).toEqual([]);
    expect(result.stderrTail.join('\n')).toContain('Invalid data found when processing input');
    expect(session.usable).toBe(true);
    expect(parseProbeOutput((await session.run(probeJob('again.ts', await tsTrack()))).stdout)?.format).toBe('mpegts');
  });

  it('refuses invalid jobs without touching FFmpeg', async () => {
    const data = new Blob(['x']);
    const invalid = (job: FfmpegJob) => session.run(job);
    await expect(invalid({ tool: 'ffprobe', args: ['-i', 'x'], inputs: [{ name: '../etc', data }], outputs: [] })).rejects.toThrow(FfmpegError);
    await expect(invalid({ tool: 'ffprobe', args: ['-i', 'x'], inputs: [{ name: 'a', data }, { name: 'a', data }], outputs: [] })).rejects.toThrow(/duplicate/);
    await expect(invalid({ tool: 'ffmpeg', args: [], inputs: [], outputs: [] })).rejects.toThrow(/arguments/);
    const ffmpeg = (outputFiles: Record<string, string>): FfmpegJob => ({ tool: 'ffmpeg', args: ['-version'], inputs: [], outputs: ['out.mp4'], outputFiles });
    await expect(invalid(ffmpeg({ 'other.mp4': 'file.mp4' }))).rejects.toThrow(/not an output/);
    await expect(invalid(ffmpeg({ 'out.mp4': '../file.mp4' }))).rejects.toThrow(/output file name/);
    expect(session.usable).toBe(true);
  });
});

describe('FfmpegSession · outputs written to files on disk (0.4.0)', () => {
  const remux = async (outputFiles?: Record<string, string>): Promise<FfmpegJob> => ({
    tool: 'ffmpeg',
    args: ['-hide_banner', '-i', inputPath('in.ts'), '-c', 'copy', '-f', 'mp4', outputPath('out.mp4')],
    inputs: [{ name: 'in.ts', data: await tsTrack() }],
    outputs: ['out.mp4'],
    ...(outputFiles ? { outputFiles } : {}),
  });

  it('hands the file back as the output, closed and kept for the caller', async () => {
    const files = new MemoryOutputFiles();
    const disk = await loadNodeSession({ files });
    const result = await disk.run(await remux({ 'out.mp4': 'task-1.k1.mp4' }));
    expect(result.exitCode).toBe(0);
    expect(result.outputs).toEqual([{ name: 'out.mp4', data: expect.any(Blob) as Blob, file: 'task-1.k1.mp4' }]);
    expect(result.outputs[0]?.data.type).toBe('video/mp4'); // typed from its name, like an OPFS file
    expect(await files.names()).toEqual(['task-1.k1.mp4']);
    expect(files.files.get('task-1.k1.mp4')?.closed).toBe(true);
    const probe = parseProbeOutput((await disk.run(probeJob('out.mp4', await syncBlob(result.outputs[0]?.data ?? new Blob())))).stdout);
    expect(probe?.streams.map((stream) => stream.codec)).toEqual(['h264', 'aac']);
  });

  it('deletes the file of a failed command', async () => {
    const files = new MemoryOutputFiles();
    const disk = await loadNodeSession({ files });
    const result = await disk.run({
      tool: 'ffmpeg',
      args: ['-hide_banner', '-i', inputPath('junk.ts'), '-c', 'copy', '-f', 'mp4', outputPath('out.mp4')],
      inputs: [{ name: 'junk.ts', data: await syncBlob(new Blob([new Uint8Array(5000).fill(0x42)])) }],
      outputs: ['out.mp4'],
      outputFiles: { 'out.mp4': 'task-1.k1.mp4' },
    });
    expect(result.exitCode).toBe(1);
    expect(await files.names()).toEqual([]);
    expect(files.removed).toEqual(['task-1.k1.mp4']);
  });

  it('fails with a disk-space error when the disk fills up, deletes the file and stays usable', async () => {
    const files = new MemoryOutputFiles();
    files.quota = 64 * 1024;
    const disk = await loadNodeSession({ files });
    await expect(disk.run(await remux({ 'out.mp4': 'task-1.k1.mp4' }))).rejects.toMatchObject({
      kind: 'disk',
      message: 'There is not enough disk space to write the merged file.',
    });
    expect(await files.names()).toEqual([]);
    expect(disk.usable).toBe(true);
    files.quota = Number.POSITIVE_INFINITY;
    expect((await disk.run(await remux({ 'out.mp4': 'task-1.k2.mp4' }))).exitCode).toBe(0);
  });

  it('streams into Blob parts when the file cannot be opened, saying why', async () => {
    const files = new MemoryOutputFiles();
    files.failOpen = new DOMException('Synchronous file access is not available here', 'NotSupportedError');
    const disk = await loadNodeSession({ files });
    const result = await disk.run(await remux({ 'out.mp4': 'task-1.k1.mp4' }));
    expect(result.exitCode).toBe(0);
    expect(result.outputs[0]).toMatchObject({ name: 'out.mp4', fileError: 'Synchronous file access is not available here' });
    expect(result.outputs[0]?.file).toBeUndefined();
    expect(result.outputs[0]?.data.size).toBeGreaterThan(8192);

    // Without a file store at all (tests, a context without OPFS).
    const plain = await session.run(await remux({ 'out.mp4': 'task-1.k1.mp4' }));
    expect(plain.outputs[0]).toMatchObject({ fileError: 'files on disk are not available here' });
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
    await expect(broken.run(job)).rejects.toMatchObject({ kind: 'crashed' });
    expect(broken.usable).toBe(false);
    await expect(broken.run(job)).rejects.toThrow(/earlier error/);
  });

  it('recognises running out of memory', async () => {
    const core = await createNodeCore();
    const oom = new FfmpegSession(core);
    core.exec = () => {
      oom.aborted('OOM'); // what the core's onAbort reports
      return 1;
    };
    await expect(oom.run({ tool: 'ffmpeg', args: ['-version'], inputs: [], outputs: [] })).rejects.toMatchObject({
      kind: 'memory',
      message: expect.stringContaining('ran out of memory') as string,
    });

    const core2 = await createNodeCore();
    core2.exec = () => {
      throw new RangeError('WebAssembly.Memory.grow(): Maximum memory size exceeded');
    };
    await expect(new FfmpegSession(core2).run({ tool: 'ffmpeg', args: ['-version'], inputs: [], outputs: [] })).rejects.toMatchObject({ kind: 'memory' });
  });
});
