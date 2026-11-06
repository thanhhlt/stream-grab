import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { distDir, entryOutputs, srcDir } from './build/paths.ts';

/**
 * Content-script build. Chrome injects manifest-declared content scripts as
 * classic scripts, so the bundle must be a single self-contained IIFE with no
 * `import`/`export` statements and no shared chunks.
 */
export default defineConfig(({ mode }) => {
  const isDev = mode === 'development';
  return {
    root: srcDir,
    publicDir: false,
    resolve: {
      alias: { '@': srcDir },
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(isDev ? 'development' : 'production'),
    },
    build: {
      outDir: distDir,
      emptyOutDir: false,
      copyPublicDir: false,
      target: 'chrome116',
      sourcemap: isDev ? 'inline' : false,
      minify: !isDev,
      reportCompressedSize: false,
      lib: {
        entry: resolve(srcDir, 'content/content-script.ts'),
        formats: ['iife'],
        name: 'StreamGrabContent',
        fileName: () => entryOutputs.contentScript,
      },
    },
  };
});
