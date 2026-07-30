/**
 * VNC (RFB-over-WebSocket) proxy between noVNC in the browser and KasmVNC.
 *
 * Unlike the CDP proxy this is NOT a passthrough — the two ends speak
 * incompatible dialects and every client frame must be rewritten. See rfb.ts.
 *
 * Deliberately has NO ping/pong keepalive: KasmVNC does not answer WebSocket
 * pings, so pinging it would trip the timeout and kill healthy sessions. The
 * CDP proxy does the opposite, on purpose. Do not "fix" the inconsistency.
 */

import { WebSocket, type RawData } from 'ws';

import {
  RfbClientFilter,
  buildServerCutText,
  parseKasmvncClipboard,
} from '../rfb.js';
import { logger } from '../logger.js';

const log = logger('vnc-proxy');

/** KasmVNC's proprietary BinaryClipboard message type. */
const KASM_BINARY_CLIPBOARD = 180;

/**
 * The first three client messages are the RFB handshake (version, security,
 * ClientInit). They are not standard client messages and must bypass the
 * filter, which only understands the post-handshake message stream.
 */
const HANDSHAKE_MESSAGES = 3;

export interface VncClientSocket {
  send(data: Buffer): void;
  close(code?: number, reason?: string): void;
  ping(): void;
  on(event: 'message', cb: (data: RawData, isBinary: boolean) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'pong', cb: () => void): void;
  readyState: number;
}

/**
 * Keepalive interval for the CLIENT leg only.
 *
 * A VNC session is idle whenever the remote screen is not changing — reading a
 * page, waiting on a form — and an idle WebSocket gets reaped: Node's own
 * `headersTimeout` closes upgraded sockets at ~60s, and reverse proxies
 * (nginx `proxy_read_timeout`, Cloudflare) do the same. Browsers answer pings
 * automatically at the protocol level, so this costs nothing and keeps the
 * session alive.
 */
export const CLIENT_PING_INTERVAL_MS = 20_000;

/** No pong within this window means the browser is gone. */
export const CLIENT_PING_TIMEOUT_MS = 70_000;

export interface VncProxyStats {
  clientToVnc: number;
  vncToClient: number;
  dropped: number;
}

/**
 * Bridge a connected noVNC client to a profile's KasmVNC WebSocket.
 * Resolves when either side closes.
 */
export interface VncProxyOptions {
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
}

export async function proxyVncWebSocket(
  client: VncClientSocket,
  wsPort: number,
  label: string,
  options: VncProxyOptions = {}
): Promise<VncProxyStats> {
  const pingIntervalMs = options.pingIntervalMs ?? CLIENT_PING_INTERVAL_MS;
  const pingTimeoutMs = options.pingTimeoutMs ?? CLIENT_PING_TIMEOUT_MS;
  const url = `ws://127.0.0.1:${wsPort}/websockify`;
  const stats: VncProxyStats = { clientToVnc: 0, vncToClient: 0, dropped: 0 };

  const upstream = new WebSocket(url, ['binary'], {
    origin: `http://127.0.0.1:${wsPort}`,
    maxPayload: 0, // a 1920x1080 framebuffer update can be large
    perMessageDeflate: false, // KasmVNC cannot handle permessage-deflate
    // No ping/pong options: KasmVNC never replies to pings.
  });

  const filter = new RfbClientFilter((msg) => log.warn(`${label}: ${msg}`));
  let handshakeSeen = 0;
  let settled = false;

  // Keepalive on the client leg only. KasmVNC never answers pings, so pinging
  // upstream would trip the timeout and kill healthy sessions — that asymmetry
  // is deliberate.
  let lastPong = Date.now();
  client.on('pong', () => {
    lastPong = Date.now();
  });
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  await new Promise<void>((resolve) => {
    const finish = (why: string) => {
      if (settled) return;
      settled = true;
      if (pingTimer) clearInterval(pingTimer);
      log.info(
        `${label}: closing (${why}) — c->v=${stats.clientToVnc} v->c=${stats.vncToClient} ` +
          `dropped=${stats.dropped} buffered=${filter.pending}`
      );
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
    };

    const pending: Buffer[] = [];

    upstream.on('open', () => {
      log.info(`${label}: connected to KasmVNC at ${url}`);
      for (const buf of pending.splice(0)) upstream.send(buf);

      lastPong = Date.now();
      pingTimer = setInterval(() => {
        if (Date.now() - lastPong > pingTimeoutMs) {
          log.warn(`${label}: no pong for ${pingTimeoutMs}ms — client is gone`);
          finish('client keepalive timeout');
          return;
        }
        try {
          if (client.readyState === WebSocket.OPEN) client.ping();
        } catch (err) {
          log.debug(`${label}: client ping failed: ${String(err)}`);
        }
      }, pingIntervalMs);
      pingTimer.unref?.();
    });

    client.on('message', (data, isBinary) => {
      if (!isBinary) {
        // noVNC only ever sends binary. A text frame would bypass the filter.
        log.warn(`${label}: dropping unexpected text frame`);
        stats.dropped++;
        return;
      }

      const buf = Buffer.isBuffer(data)
        ? data
        : Buffer.from(data as unknown as ArrayBuffer);
      stats.clientToVnc++;

      let out: Buffer;
      if (handshakeSeen < HANDSHAKE_MESSAGES) {
        handshakeSeen++;
        out = buf; // forward verbatim
      } else {
        out = filter.push(buf);
        if (out.length === 0) {
          stats.dropped++;
          return; // buffered awaiting more, or nothing forwardable
        }
      }

      if (upstream.readyState === WebSocket.OPEN) upstream.send(out);
      else pending.push(out);
    });

    upstream.on('message', (data, isBinary) => {
      const buf = Buffer.isBuffer(data)
        ? data
        : Buffer.from(data as unknown as ArrayBuffer);
      stats.vncToClient++;

      if (!isBinary || buf.length === 0) {
        try {
          client.send(buf);
        } catch (err) {
          log.warn(`${label} [v->c]: send failed: ${String(err)}`);
        }
        return;
      }

      if (buf[0] === KASM_BINARY_CLIPBOARD) {
        // Translate KasmVNC's proprietary clipboard into the standard
        // ServerCutText noVNC actually understands.
        const text = parseKasmvncClipboard(buf);
        if (text) {
          log.info(`${label} [v->c]: clipboard ${text.length} chars`);
          client.send(buildServerCutText(text));
        } else {
          log.debug(`${label} [v->c]: dropped type 180 (no text/plain)`);
        }
        return;
      }

      try {
        client.send(buf);
      } catch (err) {
        log.warn(`${label} [v->c]: send failed: ${String(err)}`);
      }
    });

    client.on('close', () => finish('client closed'));
    upstream.on('close', () => finish('KasmVNC closed'));
    client.on('error', (err) => {
      log.warn(`${label} [client]: ${err.message}`);
      finish('client error');
    });
    upstream.on('error', (err) => {
      log.warn(`${label} [upstream]: ${err.message}`);
      finish('upstream error');
    });
  });

  return stats;
}
