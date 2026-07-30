/**
 * VNC proxy tests, centred on the bug that froze the browser view: an idle
 * WebSocket was reaped after ~60s (Node's headersTimeout on upgraded sockets,
 * plus reverse-proxy idle timeouts), so the picture stopped updating while the
 * UI still showed "Connected".
 */

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { proxyVncWebSocket, type VncClientSocket } from '../src/proxy/vnc.js';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

/** Stands in for KasmVNC on /websockify. Echoes what it is told to. */
async function fakeKasmVnc(onConnect?: (ws: WebSocket) => void) {
  const wss = new WebSocketServer({ port: 0, path: '/websockify' });
  cleanups.push(() => wss.close());
  wss.on('connection', (ws) => onConnect?.(ws));
  const port = await new Promise<number>((r) =>
    wss.on('listening', () => r((wss.address() as { port: number }).port))
  );
  return { port, wss };
}

/** Wires a real client socket into the proxy and returns the client end. */
async function connectThroughProxy(
  kasmPort: number,
  options?: Parameters<typeof proxyVncWebSocket>[3]
) {
  const wss = new WebSocketServer({ port: 0 });
  cleanups.push(() => wss.close());
  wss.on('connection', (ws) => {
    void proxyVncWebSocket(ws as unknown as VncClientSocket, kasmPort, 'test', options);
  });
  const port = await new Promise<number>((r) =>
    wss.on('listening', () => r((wss.address() as { port: number }).port))
  );

  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  client.binaryType = 'nodebuffer';
  cleanups.push(() => client.close());
  await new Promise((r) => client.on('open', r));
  return client;
}

describe('VNC proxy keepalive', () => {
  /**
   * The regression test for the frozen view. An idle VNC session must still see
   * traffic on the wire, or Node (and any reverse proxy) reaps the socket and
   * the picture silently stops updating.
   */
  it('pings an idle client so the session is not reaped', async () => {
    const { port } = await fakeKasmVnc();
    let pings = 0;

    const client = await connectThroughProxy(port, {
      pingIntervalMs: 60,
      pingTimeoutMs: 10_000,
    });
    client.on('ping', () => pings++);

    // Completely idle: no RFB traffic in either direction.
    await new Promise((r) => setTimeout(r, 400));

    expect(pings).toBeGreaterThanOrEqual(3);
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it('closes the session when the client stops answering pings', async () => {
    const { port } = await fakeKasmVnc();
    const client = await connectThroughProxy(port, {
      pingIntervalMs: 40,
      pingTimeoutMs: 120,
    });

    // Suppress the automatic pong so the peer looks dead.
    client.pong = () => {};

    const closed = await new Promise<boolean>((resolve) => {
      client.on('close', () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });

    expect(closed).toBe(true);
  });

  it('does NOT ping upstream — KasmVNC never answers and would be killed', async () => {
    let upstreamPings = 0;
    const { port } = await fakeKasmVnc((ws) => {
      ws.on('ping', () => upstreamPings++);
    });

    await connectThroughProxy(port, { pingIntervalMs: 50, pingTimeoutMs: 10_000 });
    await new Promise((r) => setTimeout(r, 400));

    expect(upstreamPings).toBe(0);
  });
});

describe('VNC proxy data path', () => {
  it('forwards the RFB handshake verbatim in both directions', async () => {
    const received: Buffer[] = [];
    const { port } = await fakeKasmVnc((ws) => {
      ws.on('message', (d) => received.push(d as Buffer));
      ws.send(Buffer.from('RFB 003.008\n')); // server greeting
    });

    const client = await connectThroughProxy(port);
    const greeting = await new Promise<Buffer>((r) =>
      client.once('message', (d) => r(d as Buffer))
    );
    expect(greeting.toString()).toBe('RFB 003.008\n');

    client.send(Buffer.from('RFB 003.008\n'));
    await new Promise((r) => setTimeout(r, 150));
    expect(received[0]?.toString()).toBe('RFB 003.008\n');
  });

  it('rewrites PointerEvent to KasmVNC 11-byte form after the handshake', async () => {
    const received: Buffer[] = [];
    const { port } = await fakeKasmVnc((ws) => {
      ws.on('message', (d) => received.push(d as Buffer));
    });
    const client = await connectThroughProxy(port);

    // Three handshake messages pass through untouched...
    client.send(Buffer.from('RFB 003.008\n'));
    client.send(Buffer.from([1]));
    client.send(Buffer.from([1]));
    // ...then the filter engages. 6-byte standard PointerEvent.
    const ptr = Buffer.alloc(6);
    ptr.writeUInt8(5, 0); ptr.writeUInt8(1, 1);
    ptr.writeUInt16BE(300, 2); ptr.writeUInt16BE(400, 4);
    client.send(ptr);

    await new Promise((r) => setTimeout(r, 200));

    const last = received[received.length - 1];
    expect(last.length).toBe(11);
    expect(last[0]).toBe(5);
    expect(last.readUInt16BE(3)).toBe(300);
    expect(last.readUInt16BE(5)).toBe(400);
  });

  it('translates KasmVNC clipboard (type 180) to standard ServerCutText', async () => {
    const mime = Buffer.from('text/plain', 'latin1');
    const payload = Buffer.from('hello', 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(payload.length, 0);
    const kasmClip = Buffer.concat([
      Buffer.from([180, 0, 0, 0, 0, 0]),
      Buffer.from([mime.length]), mime, len, payload,
    ]);

    const { port } = await fakeKasmVnc((ws) => setTimeout(() => ws.send(kasmClip), 50));
    const client = await connectThroughProxy(port);

    const msg = await new Promise<Buffer>((r) =>
      client.once('message', (d) => r(d as Buffer))
    );
    expect(msg[0]).toBe(3); // ServerCutText
    expect(msg.readUInt32BE(4)).toBe(5);
    expect(msg.subarray(8).toString()).toBe('hello');
  });
});
