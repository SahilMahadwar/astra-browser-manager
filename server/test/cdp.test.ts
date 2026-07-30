/**
 * CDP proxy tests. This is the acceptance surface for the port — the Python
 * original had no keepalive, which is the most likely cause of automation
 * sessions dying mid-script.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer, type Server } from 'node:http';

import {
  probeCdp,
  proxyCdpWebSocket,
  rewriteBrowserWsUrl,
  rewritePageWsUrl,
  type ClientSocket,
} from '../src/proxy/cdp.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
});

/** Stand-in for Chrome's CDP endpoint. */
function fakeCdpServer(onMessage?: (msg: string, ws: WebSocket) => void) {
  const wss = new WebSocketServer({ port: 0 });
  cleanups.push(() => wss.close());
  wss.on('connection', (ws) => {
    ws.on('message', (data) => onMessage?.(data.toString(), ws));
  });
  return new Promise<{ url: string; wss: WebSocketServer }>((resolve) => {
    wss.on('listening', () => {
      const { port } = wss.address() as { port: number };
      resolve({ url: `ws://127.0.0.1:${port}`, wss });
    });
  });
}

/** Connects a real ws client to a server that hands the socket to the proxy. */
async function proxied(
  targetUrl: string,
  timings?: Parameters<typeof proxyCdpWebSocket>[3]
) {
  const wss = new WebSocketServer({ port: 0 });
  cleanups.push(() => wss.close());

  wss.on('connection', (ws) => {
    void proxyCdpWebSocket(ws as unknown as ClientSocket, targetUrl, 'test', timings);
  });

  const port = await new Promise<number>((resolve) =>
    wss.on('listening', () => resolve((wss.address() as { port: number }).port))
  );

  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  cleanups.push(() => client.close());
  await new Promise((r) => client.on('open', r));
  return client;
}

describe('proxyCdpWebSocket', () => {
  it('forwards messages client → CDP', async () => {
    const received: string[] = [];
    const { url } = await fakeCdpServer((msg) => received.push(msg));
    const client = await proxied(url);

    client.send(JSON.stringify({ id: 1, method: 'Page.navigate' }));
    await new Promise((r) => setTimeout(r, 150));

    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]).method).toBe('Page.navigate');
  });

  it('forwards messages CDP → client', async () => {
    const { url } = await fakeCdpServer((_msg, ws) => ws.send('{"id":1,"result":{}}'));
    const client = await proxied(url);

    const reply = new Promise<string>((r) => client.on('message', (d) => r(d.toString())));
    client.send('{"id":1,"method":"Page.enable"}');

    expect(JSON.parse(await reply).result).toEqual({});
  });

  it('does not lose messages sent before upstream connects', async () => {
    const received: string[] = [];
    const { url } = await fakeCdpServer((msg) => received.push(msg));

    // Send immediately on open, before the upstream handshake can have finished.
    const client = await proxied(url);
    client.send('{"id":1}');
    client.send('{"id":2}');

    await new Promise((r) => setTimeout(r, 250));
    expect(received).toHaveLength(2);
  });

  it('handles large payloads (screenshots, DOM dumps)', async () => {
    const big = JSON.stringify({ id: 1, result: { data: 'A'.repeat(2_000_000) } });
    const { url } = await fakeCdpServer((_msg, ws) => ws.send(big));
    const client = await proxied(url);

    const reply = new Promise<string>((r) => client.on('message', (d) => r(d.toString())));
    client.send('{"id":1}');

    expect((await reply).length).toBe(big.length);
  });

  /**
   * The regression test for the actual bug: an idle CDP session must stay
   * alive. With ping_interval disabled (the Python behaviour) nothing traverses
   * the connection at all, and intermediaries reap it.
   */
  it('pings an idle connection to keep it alive', async () => {
    const { url } = await fakeCdpServer();
    let pingsSeen = 0;

    const wss = new WebSocketServer({ port: 0 });
    cleanups.push(() => wss.close());
    wss.on('connection', (ws) => {
      void proxyCdpWebSocket(ws as unknown as ClientSocket, url, 'test', {
        pingIntervalMs: 60,
        pingTimeoutMs: 5_000,
      });
    });
    const port = await new Promise<number>((resolve) =>
      wss.on('listening', () => resolve((wss.address() as { port: number }).port))
    );

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(() => client.close());
    client.on('ping', () => pingsSeen++);
    await new Promise((r) => client.on('open', r));

    // Sit completely idle — no CDP traffic whatsoever.
    await new Promise((r) => setTimeout(r, 400));

    expect(pingsSeen).toBeGreaterThanOrEqual(3);
    expect(client.readyState).toBe(WebSocket.OPEN); // still alive
  });

  it('closes the client when the CDP endpoint dies', async () => {
    const { url, wss } = await fakeCdpServer();
    const client = await proxied(url, { drainMs: 20 });

    const closed = new Promise<number>((r) => client.on('close', (code) => r(code)));
    wss.clients.forEach((c) => c.terminate());
    wss.close();

    await expect(closed).resolves.toBeDefined();
  });

  it('drains in-flight messages instead of truncating on close', async () => {
    const { url } = await fakeCdpServer((_msg, ws) => {
      // Burst of replies, then the upstream goes away.
      for (let i = 0; i < 20; i++) ws.send(JSON.stringify({ id: i }));
      setTimeout(() => ws.close(), 10);
    });

    const client = await proxied(url, { drainMs: 300 });
    const got: string[] = [];
    client.on('message', (d) => got.push(d.toString()));

    client.send('{"go":true}');
    await new Promise((r) => setTimeout(r, 400));

    expect(got).toHaveLength(20);
  });
});

describe('probeCdp', () => {
  it('returns false for a port with nothing on it', async () => {
    expect(await probeCdp(59999)).toBe(false);
  });

  it('returns true when Chrome answers /json/version', async () => {
    const srv = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://x/devtools/browser/abc' }));
    });
    cleanups.push(() => srv.close());
    const port = await new Promise<number>((resolve) =>
      srv.listen(0, '127.0.0.1', () => resolve((srv.address() as { port: number }).port))
    );

    expect(await probeCdp(port)).toBe(true);
  });

  it('returns false when Chrome answers with an error status', async () => {
    const srv: Server = createServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    cleanups.push(() => srv.close());
    const port = await new Promise<number>((resolve) =>
      srv.listen(0, '127.0.0.1', () => resolve((srv.address() as { port: number }).port))
    );

    expect(await probeCdp(port)).toBe(false);
  });
});

describe('URL rewriting', () => {
  it('rewrites the browser-level URL through the proxy', () => {
    expect(rewriteBrowserWsUrl('localhost:8080', false, 'abc')).toBe(
      'ws://localhost:8080/api/profiles/abc/cdp'
    );
  });

  it('upgrades to wss behind an HTTPS reverse proxy', () => {
    expect(rewriteBrowserWsUrl('example.com', true, 'abc')).toBe(
      'wss://example.com/api/profiles/abc/cdp'
    );
  });

  it('preserves the page target id when rewriting page URLs', () => {
    expect(
      rewritePageWsUrl(
        'ws://127.0.0.1:5100/devtools/page/DEADBEEF',
        'localhost:8080',
        false,
        'abc'
      )
    ).toBe('ws://localhost:8080/api/profiles/abc/cdp/devtools/page/DEADBEEF');
  });
});
