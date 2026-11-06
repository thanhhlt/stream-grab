/**
 * Static checks on the built extension that catch the most common reasons an
 * unpacked MV3 extension fails to load or breaks at runtime:
 *  - files referenced by the manifest or HTML pages are missing
 *  - file or directory names starting with "_" (rejected by Chrome)
 *  - ES module syntax in the content script (it is injected as a classic script)
 *  - dynamic import() in the service worker (unsupported in service workers)
 *  - remote scripts (forbidden by MV3)
 *  - FFmpeg.wasm core missing, altered, or not where the media worker loads it
 *  - Web Worker bundles that are referenced but missing, or that import
 *    something Chrome cannot resolve
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ffmpegCoreDir } from '../build/ffmpeg-core-plugin.ts';
import { distDir, entryOutputs, ffmpegCoreOutputs, projectRoot, workersDir } from '../build/paths.ts';

export interface VerifyReport {
  errors: string[];
  info: string[];
}

interface BuiltManifest {
  manifest_version?: unknown;
  version?: unknown;
  background?: { service_worker?: string; type?: string };
  action?: { default_popup?: string; default_icon?: Record<string, string> };
  icons?: Record<string, string>;
  content_scripts?: { js?: string[]; css?: string[] }[];
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

export function verifyDist(dir: string = distDir): VerifyReport {
  const errors: string[] = [];
  const info: string[] = [];
  const manifestFile = join(dir, 'manifest.json');
  if (!existsSync(manifestFile)) {
    return { errors: [`${manifestFile} not found — run the build first`], info };
  }

  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as BuiltManifest;
  const pkg = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8')) as { version: string };

  if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3');
  if (manifest.version !== pkg.version) {
    errors.push(`manifest version ${String(manifest.version)} does not match package.json ${pkg.version}`);
  }
  if (manifest.background?.type !== 'module') errors.push('background.type must be "module"');

  const referenced = new Set<string>([entryOutputs.offscreenHtml]);
  const add = (path: string | undefined): void => {
    if (path) referenced.add(path);
  };
  add(manifest.background?.service_worker);
  add(manifest.action?.default_popup);
  Object.values(manifest.action?.default_icon ?? {}).forEach(add);
  Object.values(manifest.icons ?? {}).forEach(add);
  for (const script of manifest.content_scripts ?? []) {
    script.js?.forEach(add);
    script.css?.forEach(add);
  }

  // HTML pages reference their scripts and styles with absolute extension paths.
  for (const path of [...referenced].filter((p) => p.endsWith('.html'))) {
    const htmlFile = join(dir, path);
    if (!existsSync(htmlFile)) continue;
    const html = readFileSync(htmlFile, 'utf8');
    for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
      const ref = match[1] ?? '';
      if (/^(?:https?:)?\/\//i.test(ref)) {
        errors.push(`${path} references remote resource ${ref} (MV3 forbids remote code)`);
      } else if (ref.startsWith('/')) {
        referenced.add(ref.slice(1));
      }
    }
  }

  for (const path of referenced) {
    if (!existsSync(join(dir, path))) errors.push(`missing file referenced by the extension: ${path}`);
  }

  const files = listFiles(dir);
  for (const file of files) {
    const rel = relative(dir, file);
    if (rel.split(sep).some((part) => part.startsWith('_'))) {
      errors.push(`${rel}: names starting with "_" are reserved by Chrome`);
    }
  }

  for (const script of manifest.content_scripts?.flatMap((s) => s.js ?? []) ?? []) {
    const file = join(dir, script);
    if (!existsSync(file)) continue;
    const code = readFileSync(file, 'utf8');
    if (/^\s*(?:import|export)\b[\s{*]/m.test(code) || /\bimport\s*\(/.test(code)) {
      errors.push(`${script}: content scripts are classic scripts and must not contain import/export`);
    }
  }

  // Module service workers support static imports only; walk the static import graph.
  const swEntry = manifest.background?.service_worker;
  if (swEntry) {
    const seen = new Set<string>();
    const queue = [swEntry];
    while (queue.length > 0) {
      const rel = queue.pop() ?? '';
      if (seen.has(rel)) continue;
      seen.add(rel);
      const file = join(dir, rel);
      if (!existsSync(file)) {
        errors.push(`service worker imports missing module ${rel}`);
        continue;
      }
      const code = readFileSync(file, 'utf8');
      if (/\bimport\s*\(/.test(code)) errors.push(`${rel}: dynamic import() is not supported in service workers`);
      if (/\bdocument\.|\bwindow\./.test(code)) {
        info.push(`  note: ${rel} mentions document/window — make sure that code never runs in the service worker`);
      }
      for (const match of code.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g)) {
        const spec = match[1] ?? match[2] ?? '';
        if (spec.startsWith('.')) {
          queue.push(relative(dir, resolve(join(dir, rel), '..', spec)).split(sep).join('/'));
        } else if (spec.startsWith('/')) {
          queue.push(spec.slice(1));
        } else {
          errors.push(`${rel}: bare import "${spec}" cannot be resolved by Chrome`);
        }
      }
    }
    info.push(`service worker module graph: ${[...seen].join(', ')}`);
  }

  verifyMedia(dir, files, errors, info);

  info.push('dist/ contents:');
  let total = 0;
  for (const file of files.sort()) {
    const size = statSync(file).size;
    total += size;
    info.push(`  ${relative(dir, file).split(sep).join('/').padEnd(42)} ${formatSize(size)}`);
  }
  info.push(`  ${'total'.padEnd(42)} ${formatSize(total)}`);

  return { errors, info };
}

/** Static imports of an ES module (relative or root-relative), as dist paths. */
function staticImports(dir: string, rel: string, code: string, errors: string[]): string[] {
  const found: string[] = [];
  for (const match of code.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g)) {
    const spec = match[1] ?? match[2] ?? '';
    if (spec.startsWith('.')) found.push(relative(dir, resolve(join(dir, rel), '..', spec)).split(sep).join('/'));
    else if (spec.startsWith('/')) found.push(spec.slice(1));
    else errors.push(`${rel}: bare import "${spec}" cannot be resolved by Chrome`);
  }
  return found;
}

/**
 * FFmpeg.wasm: the core must be the package's file, byte for byte (it is
 * copied, never bundled), with its WebAssembly next to it; the engine must
 * reference it and the media worker; worker bundles must load on their own.
 */
function verifyMedia(dir: string, files: string[], errors: string[], info: string[]): void {
  const source = ffmpegCoreDir();
  for (const [output, name] of [
    [ffmpegCoreOutputs.js, 'ffmpeg-core.js'],
    [ffmpegCoreOutputs.wasm, 'ffmpeg-core.wasm'],
  ] as const) {
    const built = join(dir, output);
    if (!existsSync(built)) {
      errors.push(`missing FFmpeg core file ${output}`);
      continue;
    }
    if (!readFileSync(built).equals(readFileSync(resolve(source, name)))) errors.push(`${output} differs from @ffmpeg/core's ${name}`);
  }
  const wasm = join(dir, ffmpegCoreOutputs.wasm);
  if (existsSync(wasm) && readFileSync(wasm).subarray(0, 4).toString('latin1') !== '\0asm') errors.push(`${ffmpegCoreOutputs.wasm} is not WebAssembly`);

  const scripts = files.filter((file) => file.endsWith('.js') && !relative(dir, file).split(sep).join('/').startsWith('ffmpeg/'));
  let coreReferenced = false;
  const workers = new Set<string>();
  for (const file of scripts) {
    const code = readFileSync(file, 'utf8');
    if (code.includes(ffmpegCoreOutputs.js)) coreReferenced = true;
    for (const match of code.matchAll(/["'`]\/?((?:workers)\/[\w./-]+\.js)["'`]/g)) workers.add(match[1] ?? '');
  }
  if (!coreReferenced) errors.push(`no script references ${ffmpegCoreOutputs.js}: the media worker could not find FFmpeg`);
  if (workers.size === 0) errors.push(`no script starts a worker from ${workersDir}/`);

  // Each worker and its static imports: present, resolvable, and no remote code.
  const seen = new Set<string>();
  const queue = [...workers];
  while (queue.length > 0) {
    const rel = queue.pop() ?? '';
    if (seen.has(rel)) continue;
    seen.add(rel);
    const file = join(dir, rel);
    if (!existsSync(file)) {
      errors.push(`missing worker module ${rel}`);
      continue;
    }
    const code = readFileSync(file, 'utf8');
    if (/\bhttps?:\/\//.test(code)) errors.push(`${rel}: workers must not reference remote URLs`);
    queue.push(...staticImports(dir, rel, code, errors));
  }
  info.push(`worker module graph: ${[...seen].join(', ') || '(none)'}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = verifyDist();
  for (const line of report.info) console.log(line);
  for (const error of report.errors) console.error(`✗ ${error}`);
  if (report.errors.length > 0) process.exitCode = 1;
  else console.log('✓ dist/ verified');
}
