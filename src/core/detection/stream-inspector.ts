import type { RequestContext } from '@/core/models/detected-stream';
import { describeFetchFailure, type ManifestFetcher } from '@/core/network/manifest-fetcher';
import type { ProtocolRegistry } from '@/core/protocols/protocol-adapter';
import { errorMessage, StreamGrabError } from '@/shared/utils/errors';
import { manifestInfoFrom, type ManifestInfo } from './manifest-inspector';

export type InspectionOutcome =
  | { kind: 'manifest'; info: ManifestInfo; finalUrl: string }
  | { kind: 'not-manifest'; reason: string }
  | { kind: 'failed'; reason: string };

export interface InspectorDeps {
  fetcher: ManifestFetcher;
  protocols: ProtocolRegistry;
}

/**
 * Fetches a candidate once, confirms its protocol from the body, and parses it
 * with that protocol's adapter. The adapter reuses the downloaded body and
 * caches what it fetches, so starting a download later does not parse again.
 */
export async function inspectStream(
  deps: InspectorDeps,
  url: string,
  context: RequestContext,
  signal?: AbortSignal,
): Promise<InspectionOutcome> {
  const result = await deps.fetcher.fetchManifest(url, context, signal);
  if (result.kind === 'not-manifest' || result.kind === 'too-large') {
    return { kind: 'not-manifest', reason: describeFetchFailure(result) };
  }
  if (result.kind !== 'ok') return { kind: 'failed', reason: describeFetchFailure(result) };

  const adapter = deps.protocols.forProtocol(result.protocol);
  if (!adapter) return { kind: 'not-manifest', reason: `No adapter for ${result.protocol}` };
  try {
    const manifest = await adapter.parseManifest(url, {
      context,
      prefetched: { text: result.text, finalUrl: result.finalUrl },
      ...(signal ? { signal } : {}),
    });
    return { kind: 'manifest', info: manifestInfoFrom(manifest), finalUrl: result.finalUrl };
  } catch (error) {
    if (error instanceof StreamGrabError && error.code === 'MANIFEST_INVALID') {
      return { kind: 'not-manifest', reason: error.message };
    }
    return { kind: 'failed', reason: errorMessage(error) };
  }
}
