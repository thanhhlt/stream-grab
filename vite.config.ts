import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { ffmpegCorePlugin } from './build/ffmpeg-core-plugin.ts';
import { manifestPlugin } from './build/manifest-plugin.ts';
import { distDir, entryOutputs, projectRoot, publicDir, safeChunkName, srcDir, workersDir } from './build/paths.ts';

/**
 * Main extension build: extension pages (popup, offscreen document) and the
 * module service worker. All of these run on the chrome-extension:// origin and
 * may share ES module chunks.
 *
 * The content script is NOT built here: Chrome injects declared content scripts
 * as classic scripts, so it needs a self-contained IIFE bundle
 * (see vite.content.config.ts).
 */
export default defineConfig(({ mode }) => {
  const isDev = mode === 'development';
  return {
    root: srcDir,
    publicDir,
    base: '/',
    plugins: [
      react(),
      tailwindcss(),
      manifestPlugin({
        manifestPath: resolve(srcDir, 'manifest/manifest.json'),
        packageJsonPath: resolve(projectRoot, 'package.json'),
      }),
      ffmpegCorePlugin(),
    ],
    resolve: {
      alias: { '@': srcDir },
    },
    // The media worker (FFmpeg host) is a module worker: it imports the FFmpeg core dynamically.
    worker: {
      format: 'es',
      rolldownOptions: {
        output: {
          entryFileNames: (chunk) => `${workersDir}/${safeChunkName(chunk.name)}.js`,
          chunkFileNames: (chunk) => `${workersDir}/chunks/${safeChunkName(chunk.name)}.js`,
        },
      },
    },
    build: {
      outDir: distDir,
      // scripts/build.ts cleans dist/ once; the content-script build writes into the same folder.
      emptyOutDir: false,
      target: 'chrome116',
      // The modulepreload polyfill is useless on the extension origin and must not leak into the service worker.
      modulePreload: false,
      sourcemap: isDev ? 'inline' : false,
      minify: !isDev,
      reportCompressedSize: false,
      rolldownOptions: {
        input: {
          popup: resolve(srcDir, entryOutputs.popupHtml),
          offscreen: resolve(srcDir, entryOutputs.offscreenHtml),
          'service-worker': resolve(srcDir, 'background/service-worker.ts'),
        },
        output: {
          // Packaged extensions do not need cache-busting hashes; stable names also keep watch rebuilds from piling up stale files.
          entryFileNames: (chunk) =>
            chunk.name === 'service-worker' ? entryOutputs.serviceWorker : `pages/${safeChunkName(chunk.name)}.js`,
          chunkFileNames: (chunk) => `chunks/${safeChunkName(chunk.name)}.js`,
          assetFileNames: (asset) => `assets/${safeChunkName(asset.names[0] ?? 'asset')}`,
        },
      },
    },
  };
});
