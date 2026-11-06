/**
 * Routes of the local fixture site, shared by the manual test server
 * (scripts/fixture-server.ts) and the detection integration test, so the page
 * a human checks in Chrome and the automated scenario are the same.
 * No Node or DOM imports: file contents are injected by the caller.
 */
import { DOWNLOAD_STREAMS, type DemoRequest } from './download-routes.ts';

export interface FixtureResponse {
  status: number;
  contentType: string;
  body: string | Uint8Array<ArrayBuffer>;
  /** Simulated server latency (the manual server waits this long; tests may ignore it). */
  delayMs?: number;
}

export interface FixtureFiles {
  /** Reads a file below tests/fixtures/manifests/. */
  manifest(path: string): string;
  /** The HTML of the manual test page. */
  page(): string;
  /** The HTML of the download demo page (/download). */
  downloadPage?(): string;
}

export interface PageRequest {
  path: string;
  note: string;
  /** Frame that issues the request: 0 = the test page, 1 = the embedded iframe. */
  frameId: 0 | 1;
}

/** Requests the test page makes, in order, the way players would. */
export const PAGE_REQUESTS: readonly PageRequest[] = [
  { path: '/vod/movie/master.m3u8?token=abc&expires=1700000000', note: 'HLS master', frameId: 0 },
  { path: '/vod/movie/video/1080p/prog_index.m3u8?token=abc', note: 'variant 1080p', frameId: 0 },
  { path: '/vod/movie/audio/en/prog_index.m3u8', note: 'audio rendition', frameId: 0 },
  { path: '/vod/shared/360p/prog_index.m3u8', note: 'variant 360p', frameId: 0 },
  { path: '/vod/movie/video/1080p/segment_00000.ts', note: 'segment', frameId: 0 },
  { path: '/vod/movie/video/1080p/segment_00001.ts', note: 'segment', frameId: 0 },
  { path: '/vod/movie/master.m3u8?token=def&expires=1800000000', note: 'HLS master, rotated token', frameId: 0 },
  { path: '/api/stream/42/play', note: 'extensionless, HLS Content-Type', frameId: 0 },
  { path: '/api/video/7/playlist', note: 'extensionless, text/plain body', frameId: 0 },
  { path: '/drm/movie.mpd', note: 'DRM-protected MPD', frameId: 0 },
  { path: '/api/user', note: 'JSON API (noise)', frameId: 0 },
  { path: '/hls/720/seg-1', note: 'extensionless segment (noise)', frameId: 0 },
  { path: '/hls/720/seg-2', note: 'extensionless segment (noise)', frameId: 0 },
  { path: '/dash/sintel/stream.mpd', note: 'DASH player in iframe', frameId: 1 },
];

/** Manifest referenced by a <video src> on the test page (detected from the DOM, never requested). */
export const DOM_SOURCE_PATH = '/native/master.m3u8';

export const EMBED_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Sintel trailer (embed)</title></head>
<body style="margin:0;font:12px system-ui">
<video preload="none" muted style="height:100px;background:#111"></video> DASH player iframe
<script>fetch('/dash/sintel/stream.mpd').then((r) => r.text());</script>
</body></html>`;

const HLS = 'application/vnd.apple.mpegurl';
const DASH = 'application/dash+xml';

/** `downloads`: the download demo's routes (createDownloadRouter); without it /download/* answers 404. */
export function createFixtureRouter(
  files: FixtureFiles,
  downloads: (pathname: string, request?: DemoRequest) => FixtureResponse | undefined = () => undefined,
): (pathname: string, request?: DemoRequest) => FixtureResponse {
  const ok = (contentType: string, body: string | Uint8Array<ArrayBuffer>): FixtureResponse => ({ status: 200, contentType, body });
  const notFound: FixtureResponse = { status: 404, contentType: 'text/plain', body: 'not found' };
  return (pathname, request) => {
    if (pathname === '/') return ok('text/html; charset=utf-8', files.page());
    if (pathname === '/download') return files.downloadPage ? ok('text/html; charset=utf-8', files.downloadPage()) : notFound;
    if (pathname === '/download/streams.json') return ok('application/json', JSON.stringify(DOWNLOAD_STREAMS));
    if (pathname.startsWith('/download/')) return downloads(pathname, request) ?? notFound;
    if (pathname === '/requests.json') return ok('application/json', JSON.stringify(PAGE_REQUESTS));
    if (pathname === '/embed/dash') return ok('text/html; charset=utf-8', EMBED_PAGE);
    if (pathname.endsWith('/master.m3u8')) return ok(HLS, files.manifest('hls/master.m3u8'));
    if (pathname.endsWith('/prog_index.m3u8')) return ok(HLS, files.manifest('hls/media-ts.m3u8'));
    if (pathname.endsWith('.ts')) return ok('video/mp2t', new Uint8Array(188).fill(0x47));
    if (pathname === '/api/stream/42/play') return ok(HLS, files.manifest('hls/media-ts.m3u8'));
    // Generic type: only the body reveals an HLS playlist.
    if (pathname === '/api/video/7/playlist') return ok('text/plain; charset=utf-8', files.manifest('hls/media-fmp4.m3u8'));
    if (pathname === '/dash/sintel/stream.mpd') return ok(DASH, files.manifest('dash/static-separate-av.mpd'));
    if (pathname === '/drm/movie.mpd') return ok(DASH, files.manifest('dash/drm.mpd'));
    if (pathname === '/api/user') return ok('application/json', '{"name":"test"}');
    if (pathname.startsWith('/hls/720/seg-')) return ok('application/octet-stream', new Uint8Array(4096).fill(0x47));
    return notFound;
  };
}
