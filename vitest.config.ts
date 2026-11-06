import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { projectRoot, srcDir } from './build/paths.ts';

export default defineConfig({
  root: projectRoot,
  resolve: {
    alias: {
      '@': srcDir,
      '@tests': resolve(projectRoot, 'tests'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    unstubGlobals: true,
    // `npm run coverage`: extension code only; the entry points that only wire chrome.* together are covered by the e2e tests.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/types/**'],
      reporter: ['text-summary', 'text', 'html'],
      reportsDirectory: 'coverage',
    },
  },
});
