/**
 * Media worker: runs FFmpeg.wasm off the offscreen document's main thread.
 * Created by FfmpegService when processing starts and terminated when it is
 * idle, so the WebAssembly heap (up to 2 GB) is only held while needed.
 *
 * ffmpeg-core.js is imported dynamically from the extension package (MV3
 * forbids remote code; the build copies it to dist/ffmpeg/). Only URLs of the
 * extension's own origin are accepted.
 *
 * Merged files are written to the origin private file system through
 * synchronous access handles, which only a dedicated worker has (0.4.0).
 */
import { isCreateFfmpegCore } from '@/core/media/ffmpeg-core';
import { loadFfmpegSession } from '@/core/media/ffmpeg-session';
import { MediaWorkerHost } from '@/core/media/media-worker-host';
import { OpfsOutputFiles } from '@/core/media/output-files';

async function loadCore(coreUrl: string) {
  const url = new URL(coreUrl);
  if (url.origin !== self.location.origin) throw new Error('FFmpeg must be loaded from the extension package');
  const module = (await import(/* @vite-ignore */ url.href)) as { default?: unknown };
  if (!isCreateFfmpegCore(module.default)) throw new Error('ffmpeg-core.js has no factory export');
  return loadFfmpegSession(module.default, {}, { files: new OpfsOutputFiles() });
}

const host = new MediaWorkerHost({
  load: loadCore,
  post: (event) => {
    self.postMessage(event);
  },
});

self.onmessage = (event: MessageEvent) => {
  void host.handle(event.data);
};
