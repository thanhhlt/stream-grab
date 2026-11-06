/**
 * Redaction helpers. Stream URLs routinely carry signed tokens (CloudFront
 * policies, Akamai hdnts, JWTs) in query strings or path segments, and request
 * headers carry cookies and bearer tokens. None of that may reach logs.
 */

const REDACTED = '***';

/** Header names whose values are credentials or session identifiers. */
const SENSITIVE_HEADER_EXACT = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-csrf-token',
  'x-xsrf-token',
]);
const SENSITIVE_HEADER_PATTERN = /auth|token|secret|session|signature|api-?key|password|credential|cookie/i;

/** A run of ≥20 base64/hex-like characters mixing letters and digits looks like a token, not a file name. */
const TOKEN_RUN = /[A-Za-z0-9+/]{20,}/g;

function looksLikeTokenRun(run: string): boolean {
  return /[A-Za-z]/.test(run) && /\d/.test(run);
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** True when a path segment embeds credentials (key=value tokens such as `hdnts=exp=…~hmac=…`, or long random strings). */
export function isSensitivePathSegment(segment: string): boolean {
  const decoded = safeDecode(segment);
  if (/[=~]/.test(decoded)) return true;
  return (decoded.match(TOKEN_RUN) ?? []).some(looksLikeTokenRun);
}

/**
 * Returns a log-safe form of a URL: credentials, fragment and every query value
 * are removed, and token-like path segments are masked. Query keys are kept
 * because they help diagnose which parameters a server expects.
 */
export function redactUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return '[unparseable URL]';
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:') {
    return `${url.protocol}[redacted]`;
  }
  const path = url.pathname
    .split('/')
    .map((segment) => (isSensitivePathSegment(segment) ? REDACTED : segment))
    .join('/');
  const keys = [...new Set(url.searchParams.keys())];
  const query = keys.length > 0 ? `?${keys.map((key) => `${encodeURIComponent(key)}=${REDACTED}`).join('&')}` : '';
  return `${url.protocol}//${url.host}${path}${query}`;
}

const EMBEDDED_URL = /\b(?:https?|wss?):\/\/[^\s"'<>`]+/gi;

/** Redacts every absolute URL embedded in free text (error messages, log lines). */
export function redactText(text: string): string {
  return text.replace(EMBEDDED_URL, (match) => redactUrl(match));
}

export function isSensitiveHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_HEADER_EXACT.has(lower) || SENSITIVE_HEADER_PATTERN.test(lower);
}

export interface HeaderLike {
  name: string;
  value?: string | undefined;
}

/** Masks credential header values; `Referer`/`Origin` are reduced to log-safe URLs. */
export function redactHeaders(headers: readonly HeaderLike[]): HeaderLike[] {
  return headers.map(({ name, value }) => {
    if (value === undefined) return { name };
    if (isSensitiveHeaderName(name)) return { name, value: REDACTED };
    const lower = name.toLowerCase();
    if (lower === 'referer' || lower === 'origin') return { name, value: redactUrl(value) };
    return { name, value };
  });
}
