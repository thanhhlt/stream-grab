/** URL helpers shared by detection, parsing and downloading. */

export function parseHttpUrl(input: string, base?: string): URL | null {
  try {
    const url = base === undefined ? new URL(input) : new URL(input, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Resolves a (possibly relative) reference against a base URL; null when the
 * result is not http(s). Empty references and references containing control
 * characters are rejected: the URL parser would strip them and silently
 * resolve to the base URL itself.
 */
export function resolveHttpUrl(reference: string, base: string): string | null {
  const trimmed = reference.trim();
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (trimmed.length === 0 || /[\x00-\x1f\x7f]/.test(trimmed)) return null;
  return parseHttpUrl(trimmed, base)?.href ?? null;
}

/** Last path segment, without matrix parameters (`;jsessionid=…`). Percent-encoding is preserved. */
export function lastPathSegment(url: URL): string {
  const segments = url.pathname.split('/');
  const last = segments[segments.length - 1] ?? '';
  return last.split(';')[0] ?? '';
}

/** Lower-case extension of the last path segment without the dot, or '' (query strings are ignored). */
export function pathExtension(url: URL): string {
  const segment = lastPathSegment(url);
  const dot = segment.lastIndexOf('.');
  if (dot <= 0 || dot === segment.length - 1) return '';
  const extension = segment.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(extension) ? extension : '';
}

/** Decoded last path segment for display ("master.m3u8"), or '' when empty. */
export function fileNameOf(input: string): string {
  const url = parseHttpUrl(input);
  if (!url) return '';
  const segment = lastPathSegment(url);
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function hostnameOf(input: string | undefined): string {
  if (input === undefined) return '';
  return parseHttpUrl(input)?.hostname ?? '';
}

/**
 * Query parameters that change between requests for the same resource: signed
 * URL tokens, expiry stamps and cache busters. They are ignored when deciding
 * whether two manifest URLs are the same manifest.
 */
const VOLATILE_PARAMS = new Set([
  '_',
  'acl',
  'auth',
  'auth_key',
  'authorization',
  'cachebuster',
  'cb',
  'e',
  'exp',
  'expire',
  'expires',
  'expiry',
  'h',
  'hash',
  'hdnea',
  'hdnts',
  'hdntl',
  'hmac',
  'jwt',
  'key-pair-id',
  'md5',
  'nocache',
  'policy',
  'rand',
  'random',
  'rnd',
  'se',
  'session',
  'sessionid',
  'sid',
  'sig',
  'signature',
  'signed',
  'sp',
  'sr',
  'st',
  'sv',
  'timestamp',
  'tkn',
  'tok',
  'token',
  'ts',
  'access_token',
]);
const VOLATILE_PREFIXES = ['x-amz-', 'x-goog-', 'x-ms-'];

export function isVolatileQueryParam(name: string): boolean {
  const lower = name.toLowerCase();
  return VOLATILE_PARAMS.has(lower) || VOLATILE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Identity of a resource across token rotation: scheme, host, port and path,
 * plus the remaining query parameters sorted by name. The fragment is dropped.
 * Falls back to the raw input for unparseable URLs.
 */
export function dedupeKey(input: string): string {
  const url = parseHttpUrl(input);
  if (!url) return input;
  const params = [...url.searchParams.entries()]
    .filter(([name]) => !isVolatileQueryParam(name))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : '';
  return `${url.protocol}//${url.host}${url.pathname}${query}`;
}

/**
 * Coarse "shape" of a URL: host and path with digit runs collapsed. Segment
 * URLs of one stream (`/seg-1`, `/seg-2`, …) share a shape, so a failed
 * content probe is not repeated for each of them.
 */
export function urlShape(input: string): string {
  const url = parseHttpUrl(input);
  if (!url) return input;
  return `${url.host}${url.pathname.replace(/\d+/g, '#')}`;
}

/**
 * The Referer the browser would send for a request to `target` from a document
 * at `documentUrl` under the default policy (strict-origin-when-cross-origin).
 */
export function defaultReferrer(documentUrl: string, target: string): string | undefined {
  const document = parseHttpUrl(documentUrl);
  const request = parseHttpUrl(target);
  if (!document || !request) return undefined;
  if (document.protocol === 'https:' && request.protocol === 'http:') return undefined;
  if (document.origin === request.origin) {
    document.hash = '';
    return document.href;
  }
  return `${document.origin}/`;
}
