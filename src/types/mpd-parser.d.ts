/**
 * Minimal typings for mpd-parser (video.js), which ships none. Only the parts
 * StreamGrab reads are declared, and every field is optional: the output is
 * validated at runtime because manifests are untrusted.
 */
declare module 'mpd-parser' {
  export interface MpdByteRange {
    length?: unknown;
    offset?: unknown;
  }

  export interface MpdSegment {
    uri?: string;
    resolvedUri?: string;
    duration?: number;
    timeline?: number;
    number?: number;
    presentationTime?: number;
    discontinuity?: boolean;
    byterange?: MpdByteRange;
    map?: { uri?: string; resolvedUri?: string; byterange?: MpdByteRange };
  }

  export interface MpdPlaylistAttributes {
    NAME?: unknown;
    BANDWIDTH?: unknown;
    CODECS?: unknown;
    RESOLUTION?: { width?: unknown; height?: unknown };
    'FRAME-RATE'?: unknown;
    [key: string]: unknown;
  }

  export interface MpdPlaylist {
    attributes?: MpdPlaylistAttributes;
    uri?: string;
    resolvedUri?: string;
    endList?: boolean;
    timeline?: number;
    targetDuration?: number;
    segments?: MpdSegment[];
    /** SegmentBase: the index (sidx) of a single-file representation, not yet resolved into segments. */
    sidx?: { uri?: string; resolvedUri?: string; byterange?: MpdByteRange };
    contentProtection?: Record<string, unknown>;
  }

  export interface MpdMediaGroupMember {
    language?: string;
    default?: boolean;
    autoselect?: boolean;
    uri?: string;
    playlists?: MpdPlaylist[];
  }

  export interface MpdManifest {
    duration?: number;
    minimumUpdatePeriod?: number;
    endList?: boolean;
    playlists?: MpdPlaylist[];
    mediaGroups?: {
      AUDIO?: Record<string, Record<string, MpdMediaGroupMember>>;
      /** WebVTT text adaptation sets (mimeType text/vtt or contentType text), keyed by label. */
      SUBTITLES?: Record<string, Record<string, MpdMediaGroupMember>>;
      [group: string]: unknown;
    };
  }

  export interface MpdParseOptions {
    manifestUri?: string;
    /** Wall-clock time (ms) used to compute the segment window of dynamic MPDs. */
    NOW?: number;
    clientOffset?: number;
    eventHandler?: (event: { type: string; message: string }) => void;
  }

  export function parse(manifestString: string, options?: MpdParseOptions): MpdManifest;
}
