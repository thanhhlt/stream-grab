/**
 * Progressive media files for tests (0.3.0): one short clip (test pattern and
 * a beep, 2 s) encoded by the bundled FFmpeg.wasm (in Node) and written the
 * ways servers deliver whole files:
 *
 * - MP4 as FFmpeg writes it (index `moov` after the media data `mdat`),
 * - MP4 with `+faststart` (index first, as streaming sites prefer),
 * - fragmented MP4 (`ftyp` + empty `moov` + `moof`/`mdat` pairs): still one whole file,
 * - WebM (VP8 + Opus).
 *
 * Nothing is written to disk; generated once per process (~0.5 s).
 * Plain relative imports only, like synthetic-media.ts.
 */
import { createNodeCore } from './node-core.ts';

export interface SyntheticFiles {
  mp4: Uint8Array<ArrayBuffer>;
  mp4FastStart: Uint8Array<ArrayBuffer>;
  mp4Fragmented: Uint8Array<ArrayBuffer>;
  webm: Uint8Array<ArrayBuffer>;
}

let cache: Promise<SyntheticFiles> | undefined;

export function syntheticFiles(): Promise<SyntheticFiles> {
  cache ??= generate();
  cache.catch(() => {
    cache = undefined;
  });
  return cache;
}

async function generate(): Promise<SyntheticFiles> {
  const core = await createNodeCore();
  let errors: string[] = [];
  core.setLogger(({ type, message }) => {
    if (type === 'stderr') errors.push(message);
  });
  const run = (...args: string[]): void => {
    errors = [];
    const code = core.exec('-hide_banner', '-loglevel', 'error', ...args);
    core.reset();
    if (code !== 0) throw new Error(`FFmpeg failed (${code}): ${args.join(' ')}\n${errors.join('\n')}`);
  };
  const read = (path: string): Uint8Array<ArrayBuffer> => {
    const bytes = core.FS.readFile(path);
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return copy;
  };
  const source = [
    ...['-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x90:rate=10'],
    ...['-f', 'lavfi', '-i', 'sine=frequency=440:beep_factor=4:duration=2:sample_rate=48000'],
  ];
  run(...source, ...['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '36', '-pix_fmt', 'yuv420p'], ...['-c:a', 'aac', '-b:a', '48k', '-shortest', '/clip.mp4']);
  run('-i', '/clip.mp4', '-c', 'copy', '-movflags', '+faststart', '/fast.mp4');
  run('-i', '/clip.mp4', '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '/frag.mp4');
  run(...source, ...['-c:v', 'libvpx', '-b:v', '100k', '-c:a', 'libopus', '-b:a', '32k', '-shortest', '/clip.webm']);
  return { mp4: read('/clip.mp4'), mp4FastStart: read('/fast.mp4'), mp4Fragmented: read('/frag.mp4'), webm: read('/clip.webm') };
}
