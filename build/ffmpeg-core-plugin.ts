import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { ffmpegCoreOutputs } from './paths.ts';

/** Directory of the ESM build of @ffmpeg/core (ffmpeg-core.js + ffmpeg-core.wasm). */
export function ffmpegCoreDir(): string {
  const require = createRequire(import.meta.url);
  // The package's "require" exports point at its UMD build (dist/umd); the ESM build sits next to it.
  return resolve(dirname(require.resolve('@ffmpeg/core/wasm')), '..', 'esm');
}

/**
 * Copies FFmpeg.wasm's core into the package unchanged: MV3 forbids loading
 * code from elsewhere. It is not bundled: the media worker imports
 * `ffmpeg/ffmpeg-core.js` at run time, only when media processing starts,
 * and the core finds `ffmpeg-core.wasm` next to itself (import.meta.url).
 */
export function ffmpegCorePlugin(): Plugin {
  const dir = ffmpegCoreDir();
  const files = [
    { source: resolve(dir, 'ffmpeg-core.js'), fileName: ffmpegCoreOutputs.js },
    { source: resolve(dir, 'ffmpeg-core.wasm'), fileName: ffmpegCoreOutputs.wasm },
  ];
  return {
    name: 'streamgrab:ffmpeg-core',
    apply: 'build',
    buildStart() {
      for (const file of files) this.addWatchFile(file.source);
    },
    generateBundle() {
      for (const file of files) {
        this.emitFile({ type: 'asset', fileName: file.fileName, source: readFileSync(file.source) });
      }
    },
  };
}
