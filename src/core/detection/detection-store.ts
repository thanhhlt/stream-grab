import {
  DETECTION_EVIDENCE,
  DETECTION_STATUSES,
  DRM_SYSTEMS,
  ENCRYPTION_KINDS,
  MANIFEST_ROLES,
  MEDIA_PROTOCOLS,
  PROGRESSIVE_CONTAINERS,
  type AudioTrackSummary,
  type DetectedStream,
  type ManifestSummary,
  type MediaSummary,
  type ProgressiveInfo,
  type RequestContext,
  type VariantSummary,
} from '@/core/models/detected-stream';
import type { RemovableKeyValueArea } from '@/shared/storage/storage-area';
import { isOneOf, isRecord } from '@/shared/utils/guards';

/**
 * Detections of one tab as persisted in chrome.storage.session: in memory only,
 * survives service-worker restarts, cleared when the browser closes, readable
 * by extension pages (popup) but not by content scripts.
 */
export interface StoredTabDetections {
  version: 1;
  tabId: number;
  /** Incremented on every navigation; results of work started for an older page are discarded. */
  generation: number;
  pageUrl?: string;
  streams: DetectedStream[];
  updatedAt: number;
}

export const DETECTION_KEY_PREFIX = 'detections:';

export function detectionStorageKey(tabId: number): string {
  return `${DETECTION_KEY_PREFIX}${tabId}`;
}

export interface DetectionStore {
  load(tabId: number): Promise<StoredTabDetections | null>;
  save(data: StoredTabDetections): Promise<void>;
  remove(tabId: number): Promise<void>;
}

export class SessionDetectionStore implements DetectionStore {
  readonly #area: RemovableKeyValueArea;

  constructor(area: RemovableKeyValueArea) {
    this.#area = area;
  }

  async load(tabId: number): Promise<StoredTabDetections | null> {
    const key = detectionStorageKey(tabId);
    const items = await this.#area.get(key);
    return parseStoredTabDetections(items[key]);
  }

  save(data: StoredTabDetections): Promise<void> {
    return this.#area.set({ [detectionStorageKey(data.tabId)]: data });
  }

  remove(tabId: number): Promise<void> {
    return this.#area.remove(detectionStorageKey(tabId));
  }
}

// ------------------------------------------------------------- validation

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function parseRequestContext(raw: unknown): RequestContext {
  const context: RequestContext = {};
  if (!isRecord(raw)) return context;
  const referer = optionalString(raw['referer']);
  const origin = optionalString(raw['origin']);
  if (referer !== undefined) context.referer = referer;
  if (origin !== undefined) context.origin = origin;
  return context;
}

function parseManifestSummary(raw: unknown): ManifestSummary | undefined {
  if (!isRecord(raw)) return undefined;
  const role = raw['role'];
  const encryption = raw['encryption'];
  const drmSystems = raw['drmSystems'];
  if (!isOneOf(role, MANIFEST_ROLES) || !isOneOf(encryption, ENCRYPTION_KINDS) || !Array.isArray(drmSystems)) {
    return undefined;
  }
  return {
    role,
    encryption,
    live: raw['live'] === true,
    drmSystems: drmSystems.filter((system) => isOneOf(system, DRM_SYSTEMS)),
  };
}

const MAX_SUMMARY_ITEMS = 20;

function stringList(raw: unknown, max = MAX_SUMMARY_ITEMS): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string').slice(0, max) : [];
}

function parseVariantSummary(raw: unknown): VariantSummary | null {
  if (!isRecord(raw)) return null;
  const id = optionalString(raw['id']);
  if (id === undefined) return null;
  const summary: VariantSummary = {
    id,
    audioOnly: raw['audioOnly'] === true,
    audioTrackIds: stringList(raw['audioTrackIds']),
  };
  for (const key of ['width', 'height', 'bandwidth', 'frameRate'] as const) {
    const value = finiteNumber(raw[key]);
    if (value !== undefined && value > 0) summary[key] = value;
  }
  const videoCodec = optionalString(raw['videoCodec']);
  const audioCodec = optionalString(raw['audioCodec']);
  if (videoCodec !== undefined) summary.videoCodec = videoCodec;
  if (audioCodec !== undefined) summary.audioCodec = audioCodec;
  return summary;
}

function parseAudioTrackSummary(raw: unknown): AudioTrackSummary | null {
  if (!isRecord(raw)) return null;
  const id = optionalString(raw['id']);
  const name = optionalString(raw['name']);
  if (id === undefined || name === undefined) return null;
  const summary: AudioTrackSummary = { id, name, isDefault: raw['isDefault'] === true };
  const language = optionalString(raw['language']);
  if (language !== undefined) summary.language = language;
  const codec = optionalString(raw['codec']);
  if (codec !== undefined) summary.codec = codec;
  return summary;
}

export function parseProgressiveInfo(raw: unknown): ProgressiveInfo | undefined {
  if (!isRecord(raw) || !isOneOf(raw['container'], PROGRESSIVE_CONTAINERS)) return undefined;
  const info: ProgressiveInfo = { container: raw['container'] };
  const mimeType = optionalString(raw['mimeType']);
  if (mimeType !== undefined && mimeType.length <= 255) info.mimeType = mimeType;
  const bytes = finiteNumber(raw['bytes']);
  if (bytes !== undefined && bytes > 0 && Number.isInteger(bytes)) info.bytes = bytes;
  if (typeof raw['acceptsRanges'] === 'boolean') info.acceptsRanges = raw['acceptsRanges'];
  const fileName = optionalString(raw['fileName']);
  if (fileName !== undefined && fileName.length <= 255) info.fileName = fileName;
  return info;
}

function parseMediaSummary(raw: unknown): MediaSummary | undefined {
  if (!isRecord(raw)) return undefined;
  const list = <T>(value: unknown, parse: (item: unknown) => T | null): T[] =>
    Array.isArray(value)
      ? value
          .slice(0, MAX_SUMMARY_ITEMS)
          .map(parse)
          .filter((item): item is T => item !== null)
      : [];
  const media: MediaSummary = {
    variants: list(raw['variants'], parseVariantSummary),
    audioTracks: list(raw['audioTracks'], parseAudioTrackSummary),
  };
  const durationSec = finiteNumber(raw['durationSec']);
  if (durationSec !== undefined && durationSec >= 0) media.durationSec = durationSec;
  return media;
}

export function parseDetectedStream(raw: unknown): DetectedStream | null {
  if (!isRecord(raw)) return null;
  const { id, tabId, frameId, protocol, url, dedupeKey, status } = raw;
  const firstSeen = finiteNumber(raw['firstSeen']);
  const lastSeen = finiteNumber(raw['lastSeen']);
  if (
    typeof id !== 'string' ||
    typeof tabId !== 'number' ||
    typeof frameId !== 'number' ||
    !isOneOf(protocol, MEDIA_PROTOCOLS) ||
    typeof url !== 'string' ||
    typeof dedupeKey !== 'string' ||
    !isOneOf(status, DETECTION_STATUSES) ||
    firstSeen === undefined ||
    lastSeen === undefined
  ) {
    return null;
  }
  const evidence = Array.isArray(raw['evidence'])
    ? raw['evidence'].filter((item) => isOneOf(item, DETECTION_EVIDENCE))
    : [];
  const stream: DetectedStream = {
    id,
    tabId,
    frameId,
    protocol,
    url,
    dedupeKey,
    evidence,
    status,
    requestContext: parseRequestContext(raw['requestContext']),
    firstSeen,
    lastSeen,
  };
  const optional = {
    statusMessage: optionalString(raw['statusMessage']),
    pageUrl: optionalString(raw['pageUrl']),
    pageTitle: optionalString(raw['pageTitle']),
    title: optionalString(raw['title']),
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) stream[key as keyof typeof optional] = value;
  }
  const durationHint = finiteNumber(raw['durationHint']);
  if (durationHint !== undefined && durationHint > 0) stream.durationHint = durationHint;
  const inspectedAt = finiteNumber(raw['inspectedAt']);
  if (inspectedAt !== undefined) stream.inspectedAt = inspectedAt;
  const manifest = parseManifestSummary(raw['manifest']);
  if (manifest) stream.manifest = manifest;
  const media = parseMediaSummary(raw['media']);
  if (media) stream.media = media;
  if (Array.isArray(raw['childKeys'])) {
    stream.childKeys = raw['childKeys'].filter((key): key is string => typeof key === 'string');
  }
  if (protocol === 'progressive') {
    // A progressive file is always listed with at least its container.
    const progressive = parseProgressiveInfo(raw['progressive']);
    if (!progressive) return null;
    stream.progressive = progressive;
  }
  return stream;
}

/** Validates data read back from storage; returns null for anything unusable. */
export function parseStoredTabDetections(raw: unknown): StoredTabDetections | null {
  if (!isRecord(raw) || raw['version'] !== 1) return null;
  const tabId = finiteNumber(raw['tabId']);
  const generation = finiteNumber(raw['generation']);
  if (tabId === undefined || generation === undefined || !Array.isArray(raw['streams'])) return null;
  const streams = raw['streams'].map(parseDetectedStream).filter((stream) => stream !== null);
  const data: StoredTabDetections = {
    version: 1,
    tabId,
    generation,
    streams,
    updatedAt: finiteNumber(raw['updatedAt']) ?? 0,
  };
  const pageUrl = optionalString(raw['pageUrl']);
  if (pageUrl !== undefined) data.pageUrl = pageUrl;
  return data;
}
