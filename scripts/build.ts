/**
 * Builds the extension into dist/.
 *
 *   node scripts/build.ts            production build + dist verification
 *   node scripts/build.ts --watch    development build, rebuilds on change
 *
 * Two Vite builds are required because Chrome loads the service worker and
 * extension pages as ES modules but injects content scripts as classic scripts.
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'vite';
import { distDir, projectRoot } from '../build/paths.ts';
import { verifyDist } from './verify-dist.ts';

const watch = process.argv.includes('--watch');
const mode = watch ? 'development' : 'production';

// Empty dist/ instead of deleting it: on Windows the folder itself is often locked
// (a shell or file server using it as its working directory), its contents are not.
mkdirSync(distDir, { recursive: true });
for (const entry of readdirSync(distDir)) {
  rmSync(resolve(distDir, entry), { recursive: true, force: true });
}

const configs = ['vite.config.ts', 'vite.content.config.ts'];

if (watch) {
  // Both builds keep running; load dist/ as an unpacked extension and reload it after changes.
  await Promise.all(
    configs.map((configFile) =>
      build({ configFile: resolve(projectRoot, configFile), mode, build: { watch: {} } }),
    ),
  );
  console.log('\nWatching for changes. Load dist/ via chrome://extensions → "Load unpacked".');
} else {
  for (const configFile of configs) {
    await build({ configFile: resolve(projectRoot, configFile), mode });
  }
  const report = verifyDist(distDir);
  for (const line of report.info) console.log(line);
  if (report.errors.length > 0) {
    for (const error of report.errors) console.error(`✗ ${error}`);
    process.exitCode = 1;
  } else {
    console.log('✓ dist/ verified');
  }
}
