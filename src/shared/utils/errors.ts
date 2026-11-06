export type ErrorCode =
  | 'INVALID_MESSAGE'
  | 'UNKNOWN_MESSAGE'
  | 'RECEIVER_UNAVAILABLE'
  | 'INVALID_RESPONSE'
  | 'HANDLER_FAILED'
  | 'STORAGE_FAILED'
  /** A manifest or playlist could not be downloaded (HTTP error, expired link, timeout). */
  | 'MANIFEST_UNAVAILABLE'
  /** A manifest or playlist is malformed or exceeds safety limits. */
  | 'MANIFEST_INVALID'
  /** The stream is DRM-protected; it is never downloaded. */
  | 'DRM_PROTECTED'
  /** Valid but not supported (key scheme, protocol feature). */
  | 'UNSUPPORTED'
  | 'UNKNOWN';

/** Plain-object error form that survives structured cloning across extension contexts. */
export interface SerializedError {
  name: string;
  message: string;
  code: ErrorCode;
}

export class StreamGrabError extends Error {
  readonly code: ErrorCode;

  constructor(message: string, code: ErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StreamGrabError';
    this.code = code;
  }

  static fromSerialized(error: SerializedError): StreamGrabError {
    return new StreamGrabError(error.message, error.code);
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

export function serializeError(error: unknown, fallbackCode: ErrorCode = 'UNKNOWN'): SerializedError {
  if (error instanceof StreamGrabError) {
    return { name: error.name, message: error.message, code: error.code };
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message, code: fallbackCode };
  }
  return { name: 'Error', message: errorMessage(error), code: fallbackCode };
}
