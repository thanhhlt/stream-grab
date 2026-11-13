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

/** A WebVTT text subtitle rendition (0.7.0). Subtitles inside fMP4 (`wvtt`, `stpp`) and CEA-608/708 are not listed. */
export interface SubtitleTrack {
  /** Stable within the manifest it came from. */
  id: string;
  name: string;
  language?: string;
  isDefault: boolean;
  /** HLS FORCED=YES: shown only for foreign-language parts of the audio. */
  forced: boolean;
  hls?: {
    groupId: string;
    /** Rendition playlist of WebVTT segments. */
    playlistUrl: string;
  };
  dash?: {
    /** Representation of the text adaptation set (its highest-bandwidth one). */
    representationId: string;
  };
  /** A page subtitle file (0.7.2), not from the manifest: one WebVTT file whose cues are on the player's timeline. */
  pageFile?: true;
  /** A page subtitle file: seconds the page's player adds to its cue times. */
  offsetSec?: number;
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
  /** WebVTT subtitle renditions (0.7.0); absent or empty when there are none. */
  subtitleTracks?: SubtitleTrack[];
  /** Playlists this manifest references (HLS master: variants, renditions, I-frame playlists). */
  childUrls: string[];
  hls?: {
    kind: 'master' | 'media';
  };
}
