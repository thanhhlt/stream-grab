import type { RequestContext } from '@/core/models/detected-stream';
import type { DomSource } from '@/shared/types/page-metadata';
import { defaultReferrer } from '@/shared/utils/url';
import type { DetectionCandidate } from './detection-manager';

/**
 * Turns a manifest referenced by a media element into a detection candidate.
 * No request has been observed yet, so the request context is the Referer the
 * element's own request would carry under the default referrer policy; a real
 * network observation later replaces it.
 */
export function domSourceCandidate(
  tabId: number,
  frameId: number,
  frameUrl: string | undefined,
  source: DomSource,
  timestamp: number,
): DetectionCandidate {
  const referer = frameUrl === undefined ? undefined : defaultReferrer(frameUrl, source.url);
  const requestContext: RequestContext = referer === undefined ? {} : { referer };
  const candidate: DetectionCandidate = {
    tabId,
    frameId,
    url: source.url,
    match: { protocol: source.protocol, evidence: 'dom' },
    requestContext,
    timestamp,
  };
  if (source.title !== undefined) candidate.title = source.title;
  return candidate;
}
