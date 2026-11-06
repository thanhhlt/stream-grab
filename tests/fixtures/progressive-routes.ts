/**
 * Progressive files of the fixture site (0.3.0): real MP4 and WebM files
 * (tests/fixtures/media/synthetic-files.ts) played by <video> elements on
 * /files, served the way file servers and CDNs do: byte ranges (206 with
 * Content-Range), a redirect to the real location, a file that needs the
 * page as Referer, and an .mp4 fetched by script the way Media Source
 * Extensions players fetch segments (never a video of its own).
 *
 * Shared by the manual server (scripts/fixture-server.ts), the end-to-end
 * tests and the progressive detection integration test. Pure: the files are
 * injected. Plain relative imports only (scripts/fixture-server.ts runs this in Node).
 */
import type { DemoRequest } from './download-routes.ts';
import type { FixtureResponse } from './fixture-routes.ts';
import type { SyntheticFiles } from './media/synthetic-files.ts';

export const PROGRESSIVE_PAGE_PATH = '/files';

export interface ProgressiveFixture {
  /** What the page's <video> element points at. */
  path: string;
  /** The element's title attribute (what the popup should show). */
  title: string;
  container: 'mp4' | 'webm';
  /** Bytes of the file actually served. */
  file: keyof SyntheticFiles;
  note: string;
}

export const PROGRESSIVE_FILES: readonly ProgressiveFixture[] = [
  { path: '/files/sample.mp4', title: 'MP4 sample', container: 'mp4', file: 'mp4FastStart', note: 'MP4 with its index first (faststart), byte ranges' },
  { path: '/files/sample.webm', title: 'WebM sample', container: 'webm', file: 'webm', note: 'WebM (VP8 + Opus) in a <source type="video/webm">' },
  {
    path: '/files/protected.mp4',
    title: 'Referer-protected MP4',
    container: 'mp4',
    file: 'mp4',
    note: 'Answers 403 without this page as Referer: listed as ready only if the extension replays it',
  },
  {
    path: '/files/go/redirect.mp4',
    title: 'Redirected MP4',
    container: 'mp4',
    file: 'mp4Fragmented',
    note: 'Redirects (302) to /files/cdn/redirect-target.mp4, a fragmented MP4: listed once',
  },
];

export const REDIRECT_TARGET_PATH = '/files/cdn/redirect-target.mp4';
/** Fetched by the page's script like an MSE player's segment: must not be listed. */
export const MSE_SEGMENT_PATH = '/files/mse/chunk-1.mp4';

/**
 * A page with one slow file (6 MiB at 1 MiB/s, byte ranges, ETag): a download
 * that takes a few seconds, to cancel, retry and interrupt by closing Chrome.
 */
export const SLOW_PAGE_PATH = '/files/slow';
export const SLOW_FILE_PATH = '/files/slow/movie.mp4';
export const SLOW_FILE_TITLE = 'Slow MP4';
export const SLOW_BYTES_PER_SECOND = 1024 * 1024;
const SLOW_FILE_BYTES = 6 * 1024 * 1024;

/** The slow file's bytes: the faststart MP4 followed by padding (players and Chrome do not mind). */
export function slowFileBytes(files: SyntheticFiles): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(SLOW_FILE_BYTES);
  out.set(files.mp4FastStart);
  return out;
}

const CONTENT_TYPES = { mp4: 'video/mp4', webm: 'video/webm' } as const;

function page(): string {
  const videos = PROGRESSIVE_FILES.map((fixture) =>
    fixture.container === 'webm'
      ? `<figure><video title="${fixture.title}" preload="auto" muted controls width="320"><source src="${fixture.path}" type="video/webm"></video><figcaption>${fixture.note}</figcaption></figure>`
      : `<figure><video title="${fixture.title}" src="${fixture.path}" preload="auto" muted controls width="320"></video><figcaption>${fixture.note}</figcaption></figure>`,
  ).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>StreamGrab progressive files</title></head>
<body style="font:14px system-ui;max-width:760px;margin:24px auto;line-height:1.4">
<h1>Progressive MP4 / WebM files</h1>
<p>Each video below is one plain file played by a &lt;video&gt; element. Open the StreamGrab popup on this tab:
it should list the ${PROGRESSIVE_FILES.length} files below, once each, and not the .mp4 this page fetches by script (${MSE_SEGMENT_PATH}).</p>
${videos}
<script>fetch('${MSE_SEGMENT_PATH}').then((r) => r.arrayBuffer());</script>
</body></html>`;
}

/** A file with byte-range support, as static file servers answer. */
export function serveFile(body: Uint8Array<ArrayBuffer>, contentType: string, range: string | undefined): FixtureResponse {
  const size = body.byteLength;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range?.trim() ?? '');
  if (!match || (match[1] === '' && match[2] === '')) {
    return { status: 200, contentType, body, headers: { 'accept-ranges': 'bytes', 'content-length': String(size) } };
  }
  let start: number;
  let end: number;
  if (match[1] === '') {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) {
    return { status: 416, contentType: 'text/plain', body: '', headers: { 'content-range': `bytes */${size}` } };
  }
  const part = body.subarray(start, end + 1);
  return {
    status: 206,
    contentType,
    body: part,
    headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(part.byteLength) },
  };
}

/** True when the request comes from (or replays the Referer of) the /files page. */
function fromFilesPage(referer: string | undefined): boolean {
  if (referer === undefined) return false;
  try {
    return new URL(referer).pathname === PROGRESSIVE_PAGE_PATH;
  } catch {
    return false;
  }
}

export function createProgressiveRouter(files: SyntheticFiles): (pathname: string, request?: DemoRequest) => FixtureResponse | undefined {
  const forbidden: FixtureResponse = { status: 403, contentType: 'text/plain', body: 'Forbidden: open the video on its page' };
  const slow = slowFileBytes(files);
  return (pathname, request) => {
    if (pathname === PROGRESSIVE_PAGE_PATH) return { status: 200, contentType: 'text/html; charset=utf-8', body: page() };
    if (pathname === SLOW_PAGE_PATH) {
      const body = `<!doctype html><html><head><meta charset="utf-8"><title>StreamGrab slow file</title></head>
<body style="font:14px system-ui"><video title="${SLOW_FILE_TITLE}" src="${SLOW_FILE_PATH}" preload="metadata" muted controls width="320"></video>
<p>A ${SLOW_FILE_BYTES / 1024 ** 2} MiB file served at ${SLOW_BYTES_PER_SECOND / 1024 ** 2} MiB/s: to cancel, retry, or close Chrome during the download.</p></body></html>`;
      return { status: 200, contentType: 'text/html; charset=utf-8', body };
    }
    if (pathname === SLOW_FILE_PATH) {
      // Validators let Chrome resume the download (If-Range) where it stopped.
      const response = serveFile(slow, 'video/mp4', request?.range);
      return { ...response, headers: { ...response.headers, etag: '"slow-v1"', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' }, bytesPerSecond: SLOW_BYTES_PER_SECOND };
    }
    if (pathname === MSE_SEGMENT_PATH) return serveFile(files.mp4Fragmented, 'video/mp4', request?.range);
    if (pathname === REDIRECT_TARGET_PATH) return serveFile(files.mp4Fragmented, 'video/mp4', request?.range);
    const fixture = PROGRESSIVE_FILES.find((candidate) => candidate.path === pathname);
    if (!fixture) return undefined;
    if (pathname === '/files/go/redirect.mp4') {
      return { status: 302, contentType: 'text/plain', body: '', headers: { location: REDIRECT_TARGET_PATH } };
    }
    if (pathname === '/files/protected.mp4' && !fromFilesPage(request?.referer)) return forbidden;
    return serveFile(files[fixture.file], CONTENT_TYPES[fixture.container], request?.range);
  };
}
