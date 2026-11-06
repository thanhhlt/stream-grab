import { serializeError } from '@/shared/utils/errors';
import type { Contract, ContractsByTarget, MessageResult, MessageTarget, RequestOf, ResponseOf } from './protocol';
import { isMessageEnvelope } from './protocol';

export type MessageSender = chrome.runtime.MessageSender;

export type MessageHandler<C extends Contract, K extends keyof C> = (
  payload: RequestOf<C, K>,
  sender: MessageSender,
) => ResponseOf<C, K> | Promise<ResponseOf<C, K>>;

/** Every message type in a contract must have a handler. */
export type HandlerMap<C extends Contract> = { [K in keyof C]: MessageHandler<C, K> };

/** Signature accepted by chrome.runtime.onMessage.addListener. */
export type RuntimeMessageListener = (
  message: unknown,
  sender: MessageSender,
  sendResponse: (response: MessageResult<unknown>) => void,
) => boolean;

export interface RouterOptions {
  /** Defaults to chrome.runtime.id; injectable for tests. */
  extensionId?: string;
}

type AnyHandler = (payload: unknown, sender: MessageSender) => unknown;

/**
 * Builds an onMessage listener for one receiving context.
 *
 * - Envelopes for other targets are ignored (returns false) so the right
 *   context can respond.
 * - Messages not sent by this extension are ignored. The manifest declares no
 *   `externally_connectable`, so web pages cannot reach us anyway; this is
 *   defence in depth.
 * - Handlers may be async; the listener returns true to keep the response
 *   channel open and always answers with a MessageResult.
 * - Payloads from content scripts come from a renderer that runs untrusted page
 *   code, so handlers for content-originated messages must validate payloads at
 *   runtime rather than trust the static types.
 */
export function createMessageRouter<T extends MessageTarget>(
  target: T,
  handlers: HandlerMap<ContractsByTarget[T]>,
  options: RouterOptions = {},
): RuntimeMessageListener {
  return (message, sender, sendResponse) => {
    if (!isMessageEnvelope(message) || message.target !== target) return false;
    const extensionId = options.extensionId ?? chrome.runtime.id;
    if (sender.id !== extensionId) return false;

    if (!Object.hasOwn(handlers, message.type)) {
      sendResponse({
        ok: false,
        error: { name: 'StreamGrabError', code: 'UNKNOWN_MESSAGE', message: `No ${target} handler for "${message.type}"` },
      });
      return false;
    }
    const handler = (handlers as Record<string, AnyHandler>)[message.type] as AnyHandler;

    void Promise.resolve()
      .then(() => handler(message.payload, sender))
      .then(
        (data) => {
          sendResponse({ ok: true, data });
        },
        (error: unknown) => {
          sendResponse({ ok: false, error: serializeError(error, 'HANDLER_FAILED') });
        },
      );
    return true;
  };
}
