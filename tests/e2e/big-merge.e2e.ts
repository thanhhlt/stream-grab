import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Browser as BrowserKind, getInstalledBrowsers } from '@puppeteer/browsers';
import puppeteer, { TargetType, type Browser, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergeStoredTasks } from '@/core/download/task-store';
import { defaultAudioTracks } from '@/core/download/variant-choice';
import type { DetectedStream } from '@/core/models/detected-stream';
import type { DownloadTask } from '@/core/models/download-task';
import { STORAGE_KEYS } from '@/shared/constants';
import { dashManifest } from '@tests/fixtures/media/synthetic-manifests';
import { syntheticMedia, type Rendition } from '@tests/fixtures/media/synthetic-media';

/**
 * Opt-in measurement (STREAMGRAB_BIG_MERGE=1), not a regression test: Chrome's memory while the
 * extension merges a multi-GB DASH video into the extension's OPFS (0.4.0). The 20-second clip is
 * encoded once; the server serves it again and again with the fMP4 `tfdt` times moved on, so the
 * stream is continuous and a few hundred MB of fixture memory describe several GB.
 *
 *   STREAMGRAB_BIG_MERGE=1 STREAMGRAB_BIG_REPORT=<file.json> npx vitest run --config vitest.e2e.config.ts tests/e2e/big-merge.e2e.ts
 *
 * Needs `npm run build` and Chrome for Testing (npm run e2e:install). Temporary files (profile,
 * segments, the saved video, about 3 GB each) go to the system temp directory and are deleted.
 * Windows only (samples the memory with PowerShell).
 */

const enabled = process.env['STREAMGRAB_BIG_MERGE'] === '1';
const root = resolve(import.meta.dirname, '../..');
const dist = resolve(root, 'dist');
const CLIP_SEGMENTS = 5;
const SEGMENT_SECONDS = 4;
const CLIP_SECONDS = CLIP_SEGMENTS * SEGMENT_SECONDS;
const COPIES = Number(process.env['STREAMGRAB_BIG_COPIES'] ?? 22); // 22 × ~142 MB per 20 s ≈ 3.1 GB
const TOTAL_SEGMENTS = CLIP_SEGMENTS * COPIES;
const PAGE = '/big';
const MANIFEST = '/big/movie.mpd';

/** Adds `seconds` to every `tfdt` (base media decode time) of a fragment, in the track's timescale. */
function shiftFragment(segment: Uint8Array<ArrayBuffer>, timescale: number, seconds: number): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(segment);
  const view = new DataView(copy.buffer);
  const text = Buffer.from(copy.buffer);
  for (let at = text.indexOf('tfdt'); at !== -1; at = text.indexOf('tfdt', at + 4)) {
    const version = copy[at + 4] ?? 0;
    const time = at + 8;
    if (version === 1) view.setBigUint64(time, view.getBigUint64(time) + BigInt(Math.round(seconds * timescale)));
    else view.setUint32(time, view.getUint32(time) + Math.round(seconds * timescale));
  }
  return copy;
}

/** The track timescale from an init segment's `mdhd`. */
function timescaleOf(init: Uint8Array): number {
  const text = Buffer.from(init.buffer, init.byteOffset, init.byteLength);
  const at = text.indexOf('mdhd');
  const version = init[at + 4] ?? 0;
  return new DataView(init.buffer, init.byteOffset).getUint32(at + 4 + 4 + (version === 1 ? 16 : 8));
}

interface Site {
  origin: string;
  server: Server;
  clipBytes: number;
}

async function startSite(): Promise<Site> {
  const media = await syntheticMedia({
    segmentSeconds: SEGMENT_SECONDS,
    segments: CLIP_SEGMENTS,
    clipSeconds: CLIP_SECONDS,
    fps: 25,
    crf: 23,
    noise: 30,
    video: [{ name: 'v720', width: 1280, height: 720 }],
  });
  const video = media.fmp4.video['v720'] as Rendition;
  const audio = media.fmp4.audio;
  // The manifest lists the full length; only its durations matter.
  const stretch = (rendition: Rendition): Rendition => ({ ...rendition, segments: [], durations: Array.from({ length: TOTAL_SEGMENTS }, (_, index) => rendition.durations[index % CLIP_SEGMENTS] ?? SEGMENT_SECONDS) });
  const manifest = dashManifest([{ id: 'v720', width: 1280, height: 720, rendition: { ...stretch(video), segments: video.segments } }], { id: 'audio-en', language: 'en', rendition: { ...stretch(audio), segments: audio.segments } });
  const renditions = { v720: { rendition: video, timescale: timescaleOf(video.init as Uint8Array) }, 'audio-en': { rendition: audio, timescale: timescaleOf(audio.init as Uint8Array) } };
  const clipBytes = video.segments.reduce((sum, segment) => sum + segment.length, 0) + audio.segments.reduce((sum, segment) => sum + segment.length, 0);

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const send = (type: string, body: string | Uint8Array): void => {
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    if (path === PAGE) return send('text/html', `<!doctype html><title>Big merge</title><script>fetch('${MANIFEST}')</script>`);
    if (path === MANIFEST) return send('application/dash+xml', manifest);
    const found = /^\/big\/(v720|audio-en)\/(?:(init\.mp4)|seg-(\d+)\.m4s)$/.exec(path);
    const track = found ? renditions[found[1] as keyof typeof renditions] : undefined;
    if (!found || !track) {
      res.writeHead(404);
      return void res.end();
    }
    if (found[2]) return send('video/mp4', track.rendition.init as Uint8Array);
    const index = Number(found[3]) - 1; // $Number$ starts at 1
    const base = track.rendition.segments[index % CLIP_SEGMENTS];
    if (!base || index >= TOTAL_SEGMENTS) {
      res.writeHead(404);
      return void res.end();
    }
    send('video/mp4', shiftFragment(base, track.timescale, Math.floor(index / CLIP_SEGMENTS) * CLIP_SECONDS));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, clipBytes };
}

interface Sample {
  at: number;
  status: string;
  progress: string;
  /** Private bytes in MiB per process type of the test Chrome (browser, renderer, utility…). */
  mib: Record<string, number>;
}

/** One PowerShell loop prints the private memory of every process of this Chrome profile each 2 s. */
function sampleMemory(profile: string, onLine: (mib: Record<string, number>) => void): () => void {
  const script = `
    $profile = '${profile.replaceAll("'", "''")}'
    while ($true) {
      $out = @{}
      Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$profile*" } | ForEach-Object {
        $type = if ($_.CommandLine -match '--type=([a-z-]+)') { $Matches[1] } else { 'browser' }
        if ($type -eq 'utility' -and $_.CommandLine -match '--utility-sub-type=([\\w.]+)') { $type = 'utility:' + ($Matches[1] -replace '.*\\.','') }
        $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        if ($p) { $out[$type] = [double]$out[$type] + $p.PrivateMemorySize64 / 1MB }
      }
      ($out | ConvertTo-Json -Compress)
      Start-Sleep -Seconds 2
    }`;
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      try {
        onLine(JSON.parse(line) as Record<string, number>);
      } catch {
        // an empty or partial line
      }
    }
  });
  return () => child.kill();
}

async function send<T>(page: Page, type: string, payload: unknown): Promise<T> {
  const result: unknown = await page.evaluate(
    (type, payload): Promise<unknown> => chrome.runtime.sendMessage({ channel: 'streamgrab/v1', target: 'background', type, payload }),
    type,
    payload,
  );
  const answer = result as { ok: boolean; data?: T; error?: { message: string } };
  if (!answer.ok) throw new Error(`${type}: ${answer.error?.message ?? 'failed'}`);
  return answer.data as T;
}

async function tasks(page: Page): Promise<DownloadTask[]> {
  const items = await page.evaluate((keys) => chrome.storage.local.get(keys), [STORAGE_KEYS.tasks, STORAGE_KEYS.taskProgress]);
  return mergeStoredTasks(items[STORAGE_KEYS.tasks], items[STORAGE_KEYS.taskProgress]);
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

describe.skipIf(!enabled)('Chrome memory while merging a multi-GB video (opt-in measurement)', () => {
  let browser: Browser;
  let site: Site;
  let profile: string;
  let downloads: string;

  beforeAll(async () => {
    site = await startSite();
    profile = mkdtempSync(join(tmpdir(), 'streamgrab-big-'));
    downloads = join(profile, 'Downloads');
    mkdirSync(join(profile, 'Default'), { recursive: true });
    mkdirSync(downloads);
    writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true } }));
    const chrome = (await getInstalledBrowsers({ cacheDir: resolve(root, '.cache/chrome') }))
      .filter((candidate) => candidate.browser === BrowserKind.CHROME)
      .sort((x, y) => y.buildId.localeCompare(x.buildId, 'en', { numeric: true }))[0];
    if (!chrome) throw new Error('Chrome for Testing is missing: run `npm run e2e:install` first.');
    browser = await puppeteer.launch({ executablePath: chrome.executablePath, headless: true, userDataDir: profile, enableExtensions: [dist], args: ['--no-first-run', '--no-default-browser-check'] });
  }, 600_000);

  afterAll(async () => {
    await browser?.close();
    site?.server.close();
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  it('keeps Chrome’s memory flat while a multi-GB merge writes to OPFS', async () => {
    const worker = await browser.waitForTarget((target) => target.type() === TargetType.SERVICE_WORKER && target.url().endsWith('/background/service-worker.js'), { timeout: 30_000 });
    const extensionId = new URL(worker.url()).host;
    const page = await browser.newPage();
    await page.goto(`${site.origin}${PAGE}`);
    const ext = await browser.newPage();
    await ext.goto(`chrome-extension://${extensionId}/popup/index.html`);

    const pageUrl = `${site.origin}${PAGE}`;
    let found: { tabId: number; stream: DetectedStream } | undefined;
    for (let attempt = 0; attempt < 120 && !found; attempt += 1) {
      found = await ext.evaluate(async (pageUrl, manifest) => {
        const [tab] = (await chrome.tabs.query({})).filter((candidate) => candidate.url === pageUrl);
        if (tab?.id === undefined) return undefined;
        const key = `detections:${tab.id}`;
        const stored = (await chrome.storage.session.get(key))[key] as { streams: DetectedStream[] } | undefined;
        const stream = stored?.streams.find((candidate) => new URL(candidate.url).pathname === manifest && candidate.status === 'ready');
        return stream ? { tabId: tab.id, stream } : undefined;
      }, pageUrl, MANIFEST);
      if (!found) await sleep(250);
    }
    if (!found) {
      const dump = await ext.evaluate(async () => JSON.stringify(await chrome.storage.session.get(null)).slice(0, 1500));
      throw new Error(`the big stream was not detected: ${dump}`);
    }
    const { tabId, stream } = found;
    const variant = stream.media?.variants[0];
    if (!variant) throw new Error('no qualities');

    const samples: Sample[] = [];
    let latest: Record<string, number> = {};
    const stop = sampleMemory(profile, (mib) => (latest = mib));
    const baseline = await (async () => {
      await sleep(5000);
      return { ...latest };
    })();

    const started = Date.now();
    const request = { tabId, streamId: stream.id, variantId: variant.id, audioTrackIds: defaultAudioTracks(stream.protocol, variant, stream.media?.audioTracks ?? []), fileName: '' };
    const begun = await send<{ created: { taskId: string }[]; failed: unknown[] }>(ext, 'downloads/start', { requests: [request] });
    expect(begun.failed).toEqual([]);
    const id = begun.created[0]?.taskId;

    let task: DownloadTask | undefined;
    for (;;) {
      task = (await tasks(ext)).find((candidate) => candidate.id === id);
      samples.push({ at: Math.round((Date.now() - started) / 1000), status: `${task?.status}/${task?.processing?.stage ?? ''}`, progress: String(task?.progress?.percent ?? ''), mib: { ...latest } });
      if (task?.status === 'completed' || task?.status === 'failed' || Date.now() - started > 1_500_000) break;
      await sleep(2000);
    }
    stop();

    const sum = (mib: Record<string, number>): number => Object.values(mib).reduce((total, value) => total + value, 0);
    const peak = samples.reduce((best, sample) => (sum(sample.mib) > sum(best.mib) ? sample : best), samples[0] as Sample);
    const peakBy: Record<string, number> = {};
    for (const sample of samples) for (const [type, value] of Object.entries(sample.mib)) peakBy[type] = Math.max(peakBy[type] ?? 0, value);
    const saved = readdirSync(downloads).map((name) => ({ name, bytes: statSync(join(downloads, name)).size }));
    const report = {
      status: task?.status,
      message: task?.statusMessage,
      seconds: Math.round((Date.now() - started) / 1000),
      streamMiB: Math.round(((site.clipBytes * COPIES) / 1024 / 1024) * 10) / 10,
      baselineTotalMiB: Math.round(sum(baseline)),
      peakTotalMiB: Math.round(sum(peak.mib)),
      peakAt: peak.status,
      peakByTypeMiB: Object.fromEntries(Object.entries(peakBy).map(([type, value]) => [type, Math.round(value)])),
      saved,
      samples,
    };
    const out = process.env['STREAMGRAB_BIG_REPORT'];
    if (out) writeFileSync(out, JSON.stringify(report, null, 1));
    // eslint-disable-next-line no-console -- the measurement is the output
    console.log(JSON.stringify({ ...report, samples: undefined }, null, 1));

    expect(task?.status).toBe('completed');
    expect(saved.length).toBe(1);
  }, 1_800_000);
});
