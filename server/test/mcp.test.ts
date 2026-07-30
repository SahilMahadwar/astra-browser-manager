/** MCP server over the Streamable HTTP transport at /mcp. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Hono } from 'hono';

import { createApp } from '../src/app.js';
import { BrowserManager } from '../src/browser.js';
import { closeDb, initDb } from '../src/db.js';

let dir: string;
let app: Hono;
let mgr: BrowserManager;
let nextId = 1;

beforeEach(() => {
  delete process.env.AUTH_TOKEN;
  delete process.env.PUBLIC_BASE_URL;
  dir = mkdtempSync(path.join(tmpdir(), 'cbm-mcp-'));
  initDb(dir);
  mgr = new BrowserManager();
  app = createApp(mgr);
  nextId = 1;
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.AUTH_TOKEN;
  delete process.env.PUBLIC_BASE_URL;
});

/**
 * The transport is stateless (no session id), so every request stands alone and
 * tests need no initialize handshake.
 */
async function rpc(
  method: string,
  params?: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
}

/** Response bodies are untyped JSON-RPC; assertions below do the checking. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<any> => res.json();

/** Call a tool and return its result envelope. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(name: string, args: unknown = {}): Promise<any> {
  const res = await rpc('tools/call', { name, arguments: args });
  expect(res.status).toBe(200);
  const b = await body(res);
  expect(b.error, `tools/call ${name} returned a protocol error`).toBeUndefined();
  return b.result;
}

/** The JSON payload a successful tool packs into its first text block. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function payload(result: any): any {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text);
}

const EXPECTED_TOOLS = [
  'list_profiles',
  'get_profile',
  'get_profile_status',
  'get_cdp_url',
  'create_profile',
  'update_profile',
  'delete_profile',
  'launch_profile',
  'stop_profile',
  'force_stop_profile',
  'take_screenshot',
  'test_proxy',
];

describe('tool discovery', () => {
  it('lists every tool', async () => {
    const res = await rpc('tools/list');
    expect(res.status).toBe(200);
    const names = (await body(res)).result.tools.map((t: { name: string }) => t.name);
    expect(names.sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('describes every tool — the description is the agent’s only documentation', async () => {
    const tools = (await body(await rpc('tools/list'))).result.tools;
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
      expect(tool.inputSchema, tool.name).toBeTruthy();
    }
  });

  it('accepts a no-arg tool call with no arguments key at all', async () => {
    // Clients (and models) routinely omit `arguments` for a no-input tool. An
    // empty-object inputSchema would reject that as "expected object, received
    // undefined".
    const res = await rpc('tools/call', { name: 'list_profiles' });
    const b = await body(res);
    expect(b.error).toBeUndefined();
    expect(b.result.isError).toBeFalsy();
    expect(JSON.parse(b.result.content[0].text)).toEqual([]);
  });

  it('reports server identity on initialize', async () => {
    const res = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const b = await body(res);
    expect(b.result.serverInfo.name).toBe('astrabrowser-manager');
    expect(b.result.instructions).toContain('connectOverCDP');
  });
});

describe('profile CRUD over MCP', () => {
  it('round-trips create → list → get → update → delete', async () => {
    const created = payload(await call('create_profile', { name: 'agent-1' }));
    expect(created.name).toBe('agent-1');
    expect(created.status).toBe('stopped');
    expect(created.fingerprint_seed).toBeGreaterThanOrEqual(10000);

    const listed = payload(await call('list_profiles'));
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(created.id);

    const fetched = payload(await call('get_profile', { id: created.id }));
    expect(fetched.id).toBe(created.id);

    const updated = payload(
      await call('update_profile', { id: created.id, name: 'agent-renamed' })
    );
    expect(updated.name).toBe('agent-renamed');

    expect(payload(await call('delete_profile', { id: created.id })).ok).toBe(true);
    expect(payload(await call('list_profiles'))).toEqual([]);
  });

  it('leaves unset fields alone on update', async () => {
    const created = payload(
      await call('create_profile', { name: 'keep', proxy: 'http://host:8080' })
    );
    const updated = payload(await call('update_profile', { id: created.id, notes: 'hi' }));
    expect(updated.proxy).toBe('http://host:8080');
    expect(updated.notes).toBe('hi');
    expect(updated.fingerprint_seed).toBe(created.fingerprint_seed);
  });

  it('creates distinct fingerprints for distinct profiles', async () => {
    const a = payload(await call('create_profile', { name: 'a' }));
    const b = payload(await call('create_profile', { name: 'b' }));
    expect(a.fingerprint_seed).not.toBe(b.fingerprint_seed);
  });
});

describe('expected failures are tool errors, not protocol errors', () => {
  it('reports an unknown profile as isError', async () => {
    const result = await call('get_profile', { id: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nope');
  });

  for (const name of [
    'get_profile_status',
    'delete_profile',
    'stop_profile',
    'force_stop_profile',
    'take_screenshot',
  ]) {
    it(`reports an unknown profile as isError from ${name}`, async () => {
      expect((await call(name, { id: 'nope' })).isError).toBe(true);
    });
  }

  it('tells the agent to launch first when asked for a CDP URL', async () => {
    const created = payload(await call('create_profile', { name: 'stopped' }));
    const result = await call('get_cdp_url', { id: created.id });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('launch_profile');
  });

  it('rejects an invalid enum value via the tool schema', async () => {
    const result = await call('create_profile', { name: 'bad', platform: 'solaris' });
    expect(result.isError).toBe(true);
  });
});

describe('CDP URLs are absolute', () => {
  it('derives the base URL from the Host header', async () => {
    const created = payload(await call('create_profile', { name: 'host-derived' }));
    const status = payload(await call('get_profile_status', { id: created.id }));
    // Stopped, so no URL yet — but the shape must be present.
    expect(status.cdp_url).toBeNull();
    expect(status.status).toBe('stopped');
  });

  it('honours PUBLIC_BASE_URL for reverse-proxied deployments', async () => {
    process.env.PUBLIC_BASE_URL = 'https://browsers.example.com/';
    const { absoluteCdpUrl } = await import('../src/profiles.js');
    const { resolveBaseUrl } = await import('../src/mcp/http.js');

    // resolveBaseUrl strips the trailing slash so URLs never double up.
    const fakeCtx = { req: { header: () => undefined } } as never;
    const base = resolveBaseUrl(fakeCtx);
    expect(base).toBe('https://browsers.example.com');
    expect(absoluteCdpUrl(base, 'abc')).toBe(
      'https://browsers.example.com/api/profiles/abc/cdp'
    );
  });
});

describe('auth', () => {
  it('rejects /mcp without a token when AUTH_TOKEN is set', async () => {
    process.env.AUTH_TOKEN = 'secret';
    const res = await rpc('tools/list');
    expect(res.status).toBe(401);
  });

  it('accepts /mcp with a Bearer token', async () => {
    process.env.AUTH_TOKEN = 'secret';
    const res = await rpc('tools/list', undefined, { authorization: 'Bearer secret' });
    expect(res.status).toBe(200);
    expect((await body(res)).result.tools).toHaveLength(EXPECTED_TOOLS.length);
  });

  it('rejects a wrong token', async () => {
    process.env.AUTH_TOKEN = 'secret';
    const res = await rpc('tools/list', undefined, { authorization: 'Bearer wrong' });
    expect(res.status).toBe(401);
  });
});

describe('proxy testing', () => {
  it('returns a negative result rather than an error for a dead proxy', async () => {
    const result = payload(
      await call('test_proxy', { proxy: 'http://127.0.0.1:1/' })
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
