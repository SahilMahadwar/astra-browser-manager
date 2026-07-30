/**
 * Entry point: assembles the Hono app, WebSocket proxies, static frontend,
 * and startup/shutdown lifecycle. Replaces uvicorn + backend/main.py.
 */

import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RawData, WebSocket as WsSocket } from 'ws';

import * as db from './db.js';
import { createApp } from './app.js';
import { checkWebSocketOrigin } from './auth.js';
import { BrowserManager } from './browser.js';
import { cleanupClipboard } from './clipboard.js';
import { logFontStatus } from './fonts.js';
import {
  getCdpWebSocketUrl,
  probeCdp,
  proxyCdpWebSocket,
  type EarlyMessage,
} from './proxy/cdp.js';
import { proxyVncWebSocket } from './proxy/vnc.js';
import { logger } from './logger.js';

const log = logger('main');

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(here, '../../frontend/dist');

const mgr = new BrowserManager();
const app = createApp(mgr);
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

/** Shared guard for both WS routes. Returns the running profile, or null. */
function wsGuard(c: { req: { header(n: string): string | undefined; param(n: string): string | undefined } }) {
  const origin = c.req.header('origin');
  const host = c.req.header('host');
  if (!checkWebSocketOrigin(origin, host)) {
    log.warn(`WebSocket origin mismatch: origin=${origin} host=${host}`);
    return { error: 'origin' as const };
  }
  const id = c.req.param('id');
  if (!id) return { error: 'notfound' as const };
  const running = mgr.running.get(id);
  if (!running) return { error: 'notfound' as const };
  return { id, running };
}

// ── VNC WebSocket proxy ─────────────────────────────────────────────────────

app.get(
  '/api/profiles/:id/vnc',
  upgradeWebSocket((c) => {
    const guard = wsGuard(c);
    return {
      onOpen(_evt, ws) {
        if ('error' in guard) {
          ws.close(guard.error === 'origin' ? 4403 : 4004, guard.error);
          return;
        }
        const raw = ws.raw as unknown as WsSocket;
        void proxyVncWebSocket(
          raw as never,
          guard.running.wsPort,
          `VNC proxy [${guard.id}]`
        ).then((stats) => {
          if (!mgr.vnc.isAlive(guard.running.display)) {
            log.warn(`Xvnc for :${guard.running.display} is no longer alive`);
            for (const line of mgr.vnc.readLogTail(guard.running.display)) {
              log.info(`Xvnc[:${guard.running.display}] ${line}`);
            }
          }
          log.debug(`VNC proxy [${guard.id}] finished: ${JSON.stringify(stats)}`);
        });
      },
    };
  })
);

// ── CDP WebSocket proxies ───────────────────────────────────────────────────

app.get(
  '/api/profiles/:id/cdp',
  upgradeWebSocket((c) => {
    const guard = wsGuard(c);
    return {
      async onOpen(_evt, ws) {
        if ('error' in guard) {
          ws.close(guard.error === 'origin' ? 4403 : 4004, guard.error);
          return;
        }
        const { id, running } = guard;
        const raw = ws.raw as unknown as WsSocket;

        // Capture anything sent while we probe. Playwright fires its first
        // commands the instant the socket opens; without this they are dropped
        // and the client hangs waiting for a reply.
        const early: EarlyMessage[] = [];
        const collect = (data: RawData, isBinary: boolean) =>
          early.push({ data, isBinary });
        raw.on('message', collect);

        // A wedged Chromium never fires context 'close', so the registry can be
        // stale. Probe before committing, and evict rather than hang.
        if (!(await probeCdp(running.cdpPort))) {
          log.warn(`CDP proxy [${id}]: Chrome not answering — evicting stale entry`);
          raw.off('message', collect);
          mgr.evict(id);
          ws.close(4005, 'CDP not available');
          return;
        }

        let target: string;
        try {
          target = await getCdpWebSocketUrl(running.cdpPort);
        } catch (err) {
          log.error(`CDP proxy [${id}]: failed to get WS URL: ${String(err)}`);
          raw.off('message', collect);
          ws.close(4005, 'CDP not available');
          return;
        }

        raw.off('message', collect);
        await proxyCdpWebSocket(
          raw as never,
          target,
          `CDP proxy [${id}]`,
          {},
          early
        );
      },
    };
  })
);

app.get(
  '/api/profiles/:id/cdp/devtools/*',
  upgradeWebSocket((c) => {
    const guard = wsGuard(c);
    const url = new URL(c.req.url as unknown as string, 'http://localhost');
    const suffix = url.pathname.split('/cdp/devtools/').pop() ?? '';
    return {
      async onOpen(_evt, ws) {
        if ('error' in guard) {
          ws.close(guard.error === 'origin' ? 4403 : 4004, guard.error);
          return;
        }
        const target = `ws://127.0.0.1:${guard.running.cdpPort}/devtools/${suffix}`;
        await proxyCdpWebSocket(
          ws.raw as never,
          target,
          `CDP page proxy [${guard.id}]`
        );
      },
    };
  })
);

// ── Static frontend ─────────────────────────────────────────────────────────
// Registered last so /api/* is never swallowed by the SPA catch-all.

/**
 * Browsers refuse to execute an ES module served with a non-JavaScript MIME
 * type, so getting these wrong renders a blank page with no server-side error.
 */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

if (existsSync(FRONTEND_DIR)) {
  app.get('*', async (c) => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname.startsWith('/api/')) return c.json({ detail: 'Not found' }, 404);

    // Resolve inside FRONTEND_DIR and reject anything that escapes it, so a
    // crafted path cannot read arbitrary files off the container filesystem.
    const requested = path.resolve(FRONTEND_DIR, `.${pathname}`);
    const isContained =
      requested === FRONTEND_DIR || requested.startsWith(FRONTEND_DIR + path.sep);

    const file =
      isContained && pathname !== '/' && existsSync(requested) && statSync(requested).isFile()
        ? requested
        : null;

    // Unknown paths fall back to index.html — the SPA router handles them.
    const target = file ?? path.join(FRONTEND_DIR, 'index.html');
    const contentType =
      MIME_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream';

    // Vite emits content-hashed asset filenames, so they are safe to cache hard.
    const headers: Record<string, string> = { 'content-type': contentType };
    if (file && pathname.startsWith('/assets/')) {
      headers['cache-control'] = 'public, max-age=31536000, immutable';
    }

    return c.body(await readFile(target), 200, headers);
  });
} else {
  log.warn(`Frontend build not found at ${FRONTEND_DIR} — serving API only`);
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  db.initDb();
  logFontStatus();
  await mgr.cleanupStale();

  const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
    log.info(`AstraBrowser Manager running at http://localhost:${PORT}`);
  });

  /**
   * Node 18+ closes UPGRADED WebSocket connections after ~60s.
   *
   * `headersTimeout` defaults to min(`requestTimeout`, 60s) and its timer is not
   * cleared when a socket is upgraded, so a long-lived WebSocket is reaped as if
   * it were a client that never finished sending request headers. A VNC session
   * is idle whenever the remote screen is not changing, which is most of the
   * time — so the browser view froze roughly a minute after it was opened, while
   * CDP survived only because that proxy pings.
   *
   * See https://github.com/http-party/node-http-proxy/issues/1664 and
   * https://github.com/nodejs/node/issues/35661.
   *
   * These timeouts only guard the HTTP request-header phase (slowloris). This
   * server binds to localhost and sits behind the user's own reverse proxy when
   * exposed, so disabling them is the accepted trade for working WebSockets.
   */
  const httpServer = server as unknown as {
    headersTimeout: number;
    requestTimeout: number;
    on(ev: 'upgrade', cb: (req: unknown, socket: { setTimeout(ms: number): void }) => void): void;
  };
  httpServer.headersTimeout = 0;
  httpServer.requestTimeout = 0;

  // Belt and braces: clear any per-socket timeout once a connection is upgraded.
  httpServer.on('upgrade', (_req, socket) => {
    try {
      socket.setTimeout(0);
    } catch (err) {
      log.debug(`Could not clear socket timeout on upgrade: ${String(err)}`);
    }
  });

  injectWebSocket(server);

  // Fire and forget — a slow auto-launch must not delay accepting requests.
  void mgr.autoLaunchAll(db.listProfiles());

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received — stopping all browsers...`);
    cleanupClipboard();
    await mgr.cleanupAll();
    db.closeDb();
    server.close(() => process.exit(0));
    // Do not hang forever if a child refuses to die.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.error(`Fatal startup error: ${String(err)}`);
  process.exit(1);
});
