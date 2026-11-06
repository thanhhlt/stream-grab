import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { projectRoot, srcDir } from './build/paths.ts';

/**
 * End-to-end tests: the built extension in Chrome for Testing
 * (`npm run test:e2e`; needs `npm run e2e:install` once). Not part of
 * `npm test`: they need the browser download and take about a minute.
 */
export default defineConfig({
  root: projectRoot,
  resolve: {
    alias: {
      '@': srcDir,
      '@tests': resolve(projectRoot, 'tests'),
    },
  },
  test: {
    include: ['tests/e2e/**/*.e2e.ts'],
    environment: 'node',
    testTimeout: 240_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
