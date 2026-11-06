import type { ByteRange, ContainerFormat, MediaSegment, SegmentEncryption, TrackType } from '@/core/models/media-segment';

export interface InitSection {
  url: string;
  byteRange?: ByteRange;
  /** Defaults to fMP4 (HLS EXT-X-MAP is always ISO BMFF; DASH may use WebM). */
  container?: ContainerFormat;
}

export interface MediaFields {
  url: string;
  duration: number;
  discontinuity: number;
  container: ContainerFormat;
  byteRange?: ByteRange;
  mediaSequence?: number;
  encryption?: SegmentEncryption;
}

/**
 * Builds the ordered segment list of one track for any protocol. Positions
 * (`index`) and IDs are assigned in order, and an initialization section is
 * emitted before the first media segment that needs it and again whenever it
 * changes (HLS EXT-X-MAP, DASH periods).
 */
export class SegmentListBuilder {
  readonly segments: MediaSegment[] = [];
  readonly #track: { id: string; type: TrackType };
  #initKey: string | undefined;
  #initId: string | undefined;

  constructor(track: { id: string; type: TrackType }) {
    this.#track = track;
  }

  /** Declares the initialization section for the next media segments (undefined: self-initialising segments). */
  setInit(init: InitSection | undefined, discontinuity: number): void {
    if (!init) {
      this.#initKey = undefined;
      this.#initId = undefined;
      return;
    }
    const key = `${init.url}|${init.byteRange?.offset ?? ''}|${init.byteRange?.length ?? ''}`;
    if (key === this.#initKey) return;
    this.#initKey = key;
    this.#initId = this.#nextId();
    const segment: MediaSegment = {
      id: this.#initId,
      trackId: this.#track.id,
      trackType: this.#track.type,
      index: this.segments.length,
      kind: 'init',
      url: init.url,
      duration: 0,
      discontinuity,
      container: init.container ?? 'fmp4',
    };
    if (init.byteRange) segment.byteRange = init.byteRange;
    this.segments.push(segment);
  }

  addMedia(fields: MediaFields): MediaSegment {
    const segment: MediaSegment = {
      id: this.#nextId(),
      trackId: this.#track.id,
      trackType: this.#track.type,
      index: this.segments.length,
      kind: 'media',
      url: fields.url,
      duration: fields.duration,
      discontinuity: fields.discontinuity,
      container: fields.container,
    };
    if (fields.byteRange) segment.byteRange = fields.byteRange;
    if (fields.mediaSequence !== undefined) segment.mediaSequence = fields.mediaSequence;
    if (fields.encryption) segment.encryption = fields.encryption;
    if (this.#initId !== undefined) segment.initSegmentId = this.#initId;
    this.segments.push(segment);
    return segment;
  }

  #nextId(): string {
    return `${this.#track.id}:${this.segments.length}`;
  }
}
