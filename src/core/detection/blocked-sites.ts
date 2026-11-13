import { parseHttpUrl } from '@/shared/utils/url';

/**
 * Sites StreamGrab never detects or downloads from (0.8.0). The Chrome Web Store
 * does not accept extensions that download from YouTube, so its pages, players
 * and media hosts are left alone entirely: nothing is listed, probed or fetched.
 */
const BLOCKED_DOMAINS = ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'youtubekids.com', 'googlevideo.com'] as const;
/** Hosts blocked on their own (their parent domain is not): the old embedded player. */
const BLOCKED_EXACT_HOSTS = ['youtube.googleapis.com'] as const;

export const BLOCKED_SITE_MESSAGE = 'StreamGrab does not support this site.';

/** The host is a blocked domain or one of its subdomains (`m.youtube.com`, not `notyoutube.com`). */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if ((BLOCKED_EXACT_HOSTS as readonly string[]).includes(host)) return true;
  return BLOCKED_DOMAINS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

/** An http(s) URL on a blocked site; anything else (absent, malformed, other schemes) is not. */
export function isBlockedUrl(input: string | undefined): boolean {
  if (input === undefined) return false;
  const url = parseHttpUrl(input);
  return url !== null && isBlockedHost(url.hostname);
}

/** Any of the URLs (a media URL, its page, its Referer or Origin) is on a blocked site. */
export function involvesBlockedSite(...urls: readonly (string | undefined)[]): boolean {
  return urls.some((url) => isBlockedUrl(url));
}
