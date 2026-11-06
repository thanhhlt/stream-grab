import { describe, expect, it, vi } from 'vitest';
import { request, type Transport } from '@/shared/messaging/client';
import {
  isMessageEnvelope,
  MESSAGE_CHANNEL,
  type BackgroundContract,
  type MessageEnvelope,
  type MessageResult,
  type OffscreenContract,
} from '@/shared/messaging/protocol';
import { createMessageRouter, type HandlerMap, type MessageSender } from '@/shared/messaging/router';
import { StreamGrabError } from '@/shared/utils/errors';

// Router tests use the offscreen contract: it has a single message, and the
// router requires a handler for every message of its contract.

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const ownSender: MessageSender = { id: EXTENSION_ID };

function envelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return { channel: MESSAGE_CHANNEL, target: 'offscreen', type: 'offscreen/ping', payload: undefined, ...overrides };
}

/** Calls a router like chrome.runtime.onMessage does and resolves with what it sent back (or undefined). */
async function dispatch(
  listener: ReturnType<typeof createMessageRouter>,
  message: unknown,
  sender: MessageSender = ownSender,
): Promise<{ keptOpen: boolean; response: MessageResult<unknown> | undefined }> {
  let respond: (value: MessageResult<unknown>) => void = () => undefined;
  const responded = new Promise<MessageResult<unknown>>((resolve) => {
    respond = resolve;
  });
  let syncResponse: MessageResult<unknown> | undefined;
  const keptOpen = listener(message, sender, (value) => {
    syncResponse = value;
    respond(value);
  });
  if (keptOpen) return { keptOpen, response: await responded };
  return { keptOpen, response: syncResponse };
}

// The router demands a handler for every offscreen message; these tests only exercise the ping.
const engineStubs = {
  'engine/sync': () => ({ running: [] }),
  'engine/cancel': () => undefined,
  'engine/reacquireContexts': () => undefined,
} satisfies Omit<HandlerMap<OffscreenContract>, 'offscreen/ping'>;

const pingHandlers: HandlerMap<OffscreenContract> = {
  ...engineStubs,
  'offscreen/ping': () => ({ ready: true as const }),
};

describe('isMessageEnvelope', () => {
  it('accepts well-formed envelopes only', () => {
    expect(isMessageEnvelope(envelope())).toBe(true);
    expect(isMessageEnvelope({ ...envelope(), channel: 'other' })).toBe(false);
    expect(isMessageEnvelope({ ...envelope(), target: 'popup' })).toBe(false);
    expect(isMessageEnvelope({ ...envelope(), type: 7 })).toBe(false);
    expect(isMessageEnvelope(null)).toBe(false);
    expect(isMessageEnvelope('offscreen/ping')).toBe(false);
  });
});

describe('createMessageRouter', () => {
  it('answers requests addressed to its target', async () => {
    const router = createMessageRouter('offscreen', pingHandlers, { extensionId: EXTENSION_ID });
    await expect(dispatch(router, envelope())).resolves.toEqual({
      keptOpen: true,
      response: { ok: true, data: { ready: true } },
    });
  });

  it('passes payload and sender to async handlers', async () => {
    const handler = vi.fn(() => Promise.resolve({ ready: true as const }));
    const router = createMessageRouter('offscreen', { ...engineStubs, 'offscreen/ping': handler }, { extensionId: EXTENSION_ID });
    const sender: MessageSender = { id: EXTENSION_ID, tab: { id: 4 } as chrome.tabs.Tab, frameId: 2 };
    await dispatch(router, envelope(), sender);
    expect(handler).toHaveBeenCalledWith(undefined, sender);
  });

  it('ignores messages for other targets so another context can answer', async () => {
    const router = createMessageRouter('offscreen', pingHandlers, { extensionId: EXTENSION_ID });
    await expect(dispatch(router, envelope({ target: 'background' }))).resolves.toEqual({
      keptOpen: false,
      response: undefined,
    });
  });

  it('ignores foreign and malformed messages', async () => {
    const router = createMessageRouter('offscreen', pingHandlers, { extensionId: EXTENSION_ID });
    await expect(dispatch(router, { type: 'offscreen/ping' })).resolves.toEqual({ keptOpen: false, response: undefined });
    await expect(dispatch(router, envelope(), { id: 'some-other-extension' })).resolves.toEqual({
      keptOpen: false,
      response: undefined,
    });
    await expect(dispatch(router, envelope(), {})).resolves.toEqual({ keptOpen: false, response: undefined });
  });

  it('rejects unknown message types, including Object.prototype keys', async () => {
    const router = createMessageRouter('offscreen', pingHandlers, { extensionId: EXTENSION_ID });
    for (const type of ['offscreen/nope', 'toString', '__proto__', 'constructor']) {
      const { response } = await dispatch(router, envelope({ type }));
      expect(response).toMatchObject({ ok: false, error: { code: 'UNKNOWN_MESSAGE' } });
    }
  });

  it('serialises handler errors (sync and async)', async () => {
    const sync = createMessageRouter(
      'offscreen',
      {
        ...engineStubs,
        'offscreen/ping': () => {
          throw new Error('boom');
        },
      },
      { extensionId: EXTENSION_ID },
    );
    await expect(dispatch(sync, envelope())).resolves.toEqual({
      keptOpen: true,
      response: { ok: false, error: { name: 'Error', message: 'boom', code: 'HANDLER_FAILED' } },
    });

    const async = createMessageRouter(
      'offscreen',
      { ...engineStubs, 'offscreen/ping': () => Promise.reject(new StreamGrabError('nope', 'STORAGE_FAILED')) },
      { extensionId: EXTENSION_ID },
    );
    const { response } = await dispatch(async, envelope());
    expect(response).toEqual({ ok: false, error: { name: 'StreamGrabError', message: 'nope', code: 'STORAGE_FAILED' } });
  });
});

describe('request (client)', () => {
  const ping = (transport: Transport) =>
    request<BackgroundContract, 'runtime/ping'>(transport, 'background', 'runtime/ping', undefined);

  it('sends a typed envelope and unwraps the result', async () => {
    const transport = vi.fn<Transport>(() => Promise.resolve({ ok: true, data: { version: '1', startedAt: 5 } }));
    await expect(ping(transport)).resolves.toEqual({ version: '1', startedAt: 5 });
    expect(transport).toHaveBeenCalledWith({
      channel: MESSAGE_CHANNEL,
      target: 'background',
      type: 'runtime/ping',
      payload: undefined,
    });
  });

  it('round-trips through a router', async () => {
    const router = createMessageRouter('offscreen', pingHandlers, { extensionId: EXTENSION_ID });
    const transport: Transport = async (message) => (await dispatch(router, message)).response;
    await expect(
      request<OffscreenContract, 'offscreen/ping'>(transport, 'offscreen', 'offscreen/ping', undefined),
    ).resolves.toEqual({ ready: true });
  });

  it('rethrows remote errors with their code', async () => {
    const transport: Transport = () =>
      Promise.resolve({ ok: false, error: { name: 'StreamGrabError', message: 'disk full', code: 'STORAGE_FAILED' } });
    const failure = ping(transport);
    await expect(failure).rejects.toBeInstanceOf(StreamGrabError);
    await expect(failure).rejects.toMatchObject({ message: 'disk full', code: 'STORAGE_FAILED' });
  });

  it('reports an unreachable receiver', async () => {
    const transport: Transport = () =>
      Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
    await expect(ping(transport)).rejects.toMatchObject({ code: 'RECEIVER_UNAVAILABLE' });
  });

  it('rejects malformed responses (e.g. no listener answered)', async () => {
    const transport: Transport = () => Promise.resolve(undefined);
    await expect(ping(transport)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
