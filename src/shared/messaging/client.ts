import { errorMessage, StreamGrabError } from '@/shared/utils/errors';
import type {
  BackgroundContract,
  ContentContract,
  Contract,
  MessageEnvelope,
  MessageTarget,
  OffscreenContract,
  RequestOf,
  ResponseOf,
} from './protocol';
import { isMessageResult, MESSAGE_CHANNEL } from './protocol';

/** Lets callers omit the payload argument for messages whose request type is `undefined`. */
export type PayloadArgs<C extends Contract, K extends keyof C> =
  RequestOf<C, K> extends undefined ? [payload?: undefined] : [payload: RequestOf<C, K>];

export type Transport = (envelope: MessageEnvelope) => Promise<unknown>;

export async function request<C extends Contract, K extends keyof C & string>(
  transport: Transport,
  target: MessageTarget,
  type: K,
  payload: RequestOf<C, K> | undefined,
): Promise<ResponseOf<C, K>> {
  const envelope: MessageEnvelope = { channel: MESSAGE_CHANNEL, target, type, payload };
  let raw: unknown;
  try {
    raw = await transport(envelope);
  } catch (error) {
    // e.g. "Could not establish connection. Receiving end does not exist."
    throw new StreamGrabError(`Could not reach ${target} for "${type}": ${errorMessage(error)}`, 'RECEIVER_UNAVAILABLE', {
      cause: error,
    });
  }
  if (!isMessageResult(raw)) {
    throw new StreamGrabError(`Invalid response from ${target} for "${type}"`, 'INVALID_RESPONSE');
  }
  if (!raw.ok) throw StreamGrabError.fromSerialized(raw.error);
  return raw.data;
}

const runtimeTransport: Transport = (envelope) => chrome.runtime.sendMessage(envelope);

/** Sends a request to the service worker (waking it if it was suspended). */
export function sendToBackground<K extends keyof BackgroundContract>(
  type: K,
  ...[payload]: PayloadArgs<BackgroundContract, K>
): Promise<ResponseOf<BackgroundContract, K>> {
  return request<BackgroundContract, K>(runtimeTransport, 'background', type, payload);
}

/** Sends a request to the offscreen document. The caller must ensure the document exists. */
export function sendToOffscreen<K extends keyof OffscreenContract>(
  type: K,
  ...[payload]: PayloadArgs<OffscreenContract, K>
): Promise<ResponseOf<OffscreenContract, K>> {
  return request<OffscreenContract, K>(runtimeTransport, 'offscreen', type, payload);
}

/** Sends a request to the content script in one frame of a tab (top frame when `frameId` is omitted). */
export function sendToContent<K extends keyof ContentContract>(
  tabId: number,
  frameId: number | undefined,
  type: K,
  ...[payload]: PayloadArgs<ContentContract, K>
): Promise<ResponseOf<ContentContract, K>> {
  const transport: Transport = (envelope) =>
    chrome.tabs.sendMessage(tabId, envelope, { frameId: frameId ?? 0 });
  return request<ContentContract, K>(transport, 'content', type, payload);
}
