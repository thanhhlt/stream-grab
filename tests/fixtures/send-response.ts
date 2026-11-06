/**
 * Writes a fixture response over Node's http server, shared by the manual
 * server (scripts/fixture-server.ts) and the end-to-end fixture site: after
 * the response's latency, and at its throttled rate when it has one (slow
 * downloads to cancel, interrupt or resume), stopping as soon as the client
 * goes away. Plain relative imports only (scripts run this in Node).
 */
import type { ServerResponse } from 'node:http';
import type { FixtureResponse } from './fixture-routes.ts';

const TICK_MS = 100;

export function sendResponse(res: ServerResponse, response: FixtureResponse): void {
  const send = (): void => {
    if (res.destroyed) return; // the client gave up (e.g. a cancelled download)
    res.writeHead(response.status, { 'content-type': response.contentType, 'cache-control': 'no-store', ...response.headers });
    const rate = response.bytesPerSecond;
    const body = response.body;
    if (rate === undefined || typeof body === 'string' || body.length === 0) {
      res.end(body);
      return;
    }
    const chunk = Math.max(1024, Math.round((rate * TICK_MS) / 1000));
    let at = 0;
    const timer = setInterval(() => {
      if (res.destroyed) {
        clearInterval(timer);
        return;
      }
      const part = body.subarray(at, at + chunk);
      at += part.length;
      if (at >= body.length) {
        clearInterval(timer);
        res.end(part);
      } else {
        res.write(part);
      }
    }, TICK_MS);
    res.on('close', () => {
      clearInterval(timer);
    });
  };
  if (response.delayMs) setTimeout(send, response.delayMs);
  else send();
}
