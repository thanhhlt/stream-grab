import type { DrmSystem, EncryptionKind, RequestContext, StreamingProtocol } from './detected-stream';
import type { VideoVariant } from './video-variant';

export interface AudioTrack {
  /** Stable within the manifest it came from. */
  id: string;
  name: string;
  language?: string;
  isDefault: boolean;
  /** RFC 6381 codec, when the manifest declares it per track (DASH). */
  codec?: string;
  hls?: {
    groupId: string;
    /** Rendition playlist. Absent when this audio is carried inside the variant streams themselves. */
    playlistUrl?: string;
  };
  dash?: {
    /** Representation used for this track (the highest-bandwidth one of its adaptation set). */
    representationId: string;
  };
}

/** Protocol-independent view of a parsed manifest. */
export interface StreamingManifest {
  protocol: StreamingProtocol;
  /** URL the manifest was requested with. */
  requestedUrl: string;
  /** URL after redirects; relative references resolve against it. */
  url: string;
  /** Request context replayed for every request derived from this manifest. */
  requestContext: RequestContext;
  isLive: boolean;
  /** Seconds; undefined for live streams or when no media playlist could be read. */
  durationSec?: number;
  drmSystems: DrmSystem[];
  encryption: EncryptionKind;
  variants: VideoVariant[];
  audioTracks: AudioTrack[];
  /** Playlists this manifest references (HLS master: variants, renditions, I-frame playlists). */
  childUrls: string[];
  hls?: {
    kind: 'master' | 'media';
  };
}
