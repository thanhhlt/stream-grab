import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

interface ManifestPluginOptions {
  /** Absolute path of the source manifest (src/manifest/manifest.json). */
  manifestPath: string;
  /** Absolute path of package.json; its version is the single source of truth. */
  packageJsonPath: string;
}

/**
 * Emits `manifest.json` into the build output.
 *
 * The source manifest stays a plain JSON file (easy to review, testable without a
 * build) and the extension version is stamped from package.json so the two can never
 * drift apart.
 */
export function manifestPlugin(options: ManifestPluginOptions): Plugin {
  return {
    name: 'streamgrab:manifest',
    apply: 'build',
    buildStart() {
      this.addWatchFile(options.manifestPath);
      this.addWatchFile(options.packageJsonPath);
    },
    generateBundle() {
      const manifest = JSON.parse(readFileSync(options.manifestPath, 'utf8')) as Record<string, unknown>;
      const pkg = JSON.parse(readFileSync(options.packageJsonPath, 'utf8')) as { version?: unknown };
      if (typeof pkg.version !== 'string' || !/^\d+(\.\d+){0,3}$/.test(pkg.version)) {
        this.error(`package.json version "${String(pkg.version)}" is not a valid Chrome extension version`);
      }
      manifest['version'] = pkg.version;
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      });
    },
  };
}
