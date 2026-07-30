/**
 * CDP (Chrome DevTools Protocol) WebSocket proxy.
 *
 * CDP is plain JSON over WebSocket, so unlike the VNC proxy there is no
 * protocol translation — but stability requirements are much higher, because
 * this is the surface Playwright/Puppeteer automation is built on.
 *
 * Three things the Python original got wrong, fixed here:
 *
 *  1. **No keepalive.** It connected with ping_interval=None on both legs.
 *     That is correct for VNC (KasmVNC never answers pings) but wrong for CDP:
 *     automation sits idle between commands, and any reverse proxy or load
 *     balancer silently reaps an idle WebSocket. Neither side notices until the
 *     next write fails, which looks like a random mid-script CDP death.
 *  2. **Truncation on teardown.** It raced both directions with FIRST_COMPLETED
 *     and cancelled the loser immediately, which can abort mid-message.
 *  3. **Stale registry entries.** A wedged-but-alive Chromium left the profile
 *     in `running`, so connects hung instead of returning 404.
 */

import { WebSocket, type RawData } from 'ws';

import { logger } from '../logger.js';

const log = logger('cdp');

/** How often to ping each leg. Comfortably under typical 60s LB idle timeouts. */
export const PING_INTERVAL_MS = 20_000;

/** Missing this many consecutive pongs closes the connection as dead. */
export const PING_TIMEOUT_MS = 60_000;

/** How long the surviving direction may keep flushing after the other ends. */
const DRAIN_TIMEOUT_MS = 2_000;

/** Liveness probe budget before accepting a CDP upgrade. */
const PROBE_TIMEOUT_MS = 3_000;

/**
 * Minimal view of the client socket the proxy needs. Hono's WSContext exposes
 * send/close but no ping(), so callers pass the underlying `ws` socket from
 * WSContext.raw — that is what makes keepalive possible.
 */
export interface ClientSocket {
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  ping(): void;
  on(event: 'message', cb: (data: RawData, isBinary: boolean) => void): void;
  on(event: 'close', cb: (code: number, reason: Buffer) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'pong', cb: () => void): void;
  readyState: number;
}

/**
 * Ask Chrome whether it is actually answering on its CDP port.
 *
 * The in-memory `running` map only learns about a dead browser via the
 * context 'close' event; a hung Chromium never fires it. Probing here turns a
 * hang into a clean 404.
 */
export async function probeCdp(cdpPort: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Fetch Chrome's browser-level CDP WebSocket URL. */
export async function getCdpWebSocketUrl(cdpPort: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`CDP /json/version returned ${res.status}`);
  const data = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!data.webSocketDebuggerUrl) throw new Error('CDP response has no webSocketDebuggerUrl');
  return data.webSocketDebuggerUrl;
}

/**
 * Keep a socket alive and detect death. Returns a cleanup function.
 *
 * Pings on an interval; if no pong arrives within PING_TIMEOUT_MS the peer is
 * treated as gone and `onDead` fires. Without this, a reaped idle connection
 * looks healthy until the next write.
 */
function keepAlive(
  socket: { ping(): void; on(ev: 'pong', cb: () => void): void; readyState: number },
  label: string,
  onDead: () => void,
  intervalMs: number,
  timeoutMs: number
): () => void {
  let lastPong = Date.now();

  socket.on('pong', () => {
    lastPong = Date.now();
  });

  const timer = setInterval(() => {
    if (Date.now() - lastPong > timeoutMs) {
      log.warn(`${label}: no pong for ${timeoutMs}ms — treating peer as dead`);
      clearInterval(timer);
      onDead();
      return;
    }
    try {
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    } catch (err) {
      log.debug(`${label}: ping failed: ${String(err)}`);
    }
  }, intervalMs);

  // Do not hold the event loop open on shutdown.
  timer.unref?.();

  return () => clearInterval(timer);
}

function toSendable(data: RawData, isBinary: boolean): string | Buffer {
  if (isBinary) return Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
  return data.toString();
}

/**
 * Bidirectional passthrough between a connected client socket and a CDP target.
 * Resolves once both sides are closed and the drain window has elapsed.
 */
export interface ProxyTimings {
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  drainMs?: number;
}

/**
 * Messages the caller captured between the client's WebSocket opening and this
 * proxy being ready. The route handler must probe Chrome's liveness first, and
 * clients (Playwright especially) start sending commands the instant the socket
 * opens — without this hand-off those first commands are silently dropped and
 * the session hangs waiting for a reply that will never come.
 */
export interface EarlyMessage {
  data: RawData;
  isBinary: boolean;
}

export async function proxyCdpWebSocket(
  client: ClientSocket,
  targetUrl: string,
  label: string,
  timings: ProxyTimings = {},
  early: EarlyMessage[] = []
): Promise<void> {
  const pingIntervalMs = timings.pingIntervalMs ?? PING_INTERVAL_MS;
  const pingTimeoutMs = timings.pingTimeoutMs ?? PING_TIMEOUT_MS;
  const drainMs = timings.drainMs ?? DRAIN_TIMEOUT_MS;

  const upstream = new WebSocket(targetUrl, {
    maxPayload: 0, // CDP payloads (screenshots, DOM dumps) can be very large
    perMessageDeflate: false,
  });

  let settled = false;
  let stopClientKeepAlive = () => {};
  let stopUpstreamKeepAlive = () => {};

  await new Promise<void>((resolve) => {
    const finish = (why: string) => {
      if (settled) return;
      settled = true;
      log.info(`${label}: closing (${why})`);
      stopClientKeepAlive();
      stopUpstreamKeepAlive();

      // Let the other direction flush rather than cutting mid-message.
      setTimeout(() => {
        try {
          if (upstream.readyState === WebSocket.OPEN) upstream.close();
        } catch (err) {
          log.debug(`${label}: upstream close failed: ${String(err)}`);
        }
        try {
          if (client.readyState === WebSocket.OPEN) client.close();
        } catch (err) {
          log.debug(`${label}: client close failed: ${String(err)}`);
        }
        resolve();
      }, drainMs).unref?.();
    };

    // Messages that arrive before upstream is open would otherwise be lost.
    // Seeded with anything the caller captured before the proxy was wired up.
    const pending: Array<string | Buffer> = early.map((m) =>
      toSendable(m.data, m.isBinary)
    );
    if (pending.length > 0) {
      log.info(`${label}: replaying ${pending.length} message(s) sent before setup`);
    }

    upstream.on('open', () => {
      log.info(`${label}: connected to ${targetUrl}`);
      for (const msg of pending.splice(0)) upstream.send(msg);

      stopClientKeepAlive = keepAlive(
        client,
        `${label} [client]`,
        () => finish('client keepalive timeout'),
        pingIntervalMs,
        pingTimeoutMs
      );
      stopUpstreamKeepAlive = keepAlive(
        upstream,
        `${label} [upstream]`,
        () => finish('upstream keepalive timeout'),
        pingIntervalMs,
        pingTimeoutMs
      );
    });

    client.on('message', (data, isBinary) => {
      const msg = toSendable(data, isBinary);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(msg);
      else pending.push(msg);
    });

    upstream.on('message', (data, isBinary) => {
      try {
        client.send(toSendable(data, isBinary));
      } catch (err) {
        log.warn(`${label} [cdp->client]: send failed: ${String(err)}`);
      }
    });

    client.on('close', () => finish('client closed'));
    upstream.on('close', () => finish('upstream closed'));

    client.on('error', (err) => {
      log.warn(`${label} [client]: ${err.message}`);
      finish('client error');
    });
    upstream.on('error', (err) => {
      log.warn(`${label} [upstream]: ${err.message}`);
      finish('upstream error');
    });
  });
}

/**
 * Rewrite a webSocketDebuggerUrl so external clients route back through this
 * server on port 8080 rather than an unreachable container-internal port.
 */
export function rewriteBrowserWsUrl(
  host: string,
  isHttps: boolean,
  profileId: string
): string {
  return `${isHttps ? 'wss' : 'ws'}://${host}/api/profiles/${profileId}/cdp`;
}

export function rewritePageWsUrl(
  original: string,
  host: string,
  isHttps: boolean,
  profileId: string
): string {
  const wsPath = original.split('/devtools/').pop() ?? '';
  return `${isHttps ? 'wss' : 'ws'}://${host}/api/profiles/${profileId}/cdp/devtools/${wsPath}`;
}
