/** Ported from backend/tests/test_api.py and test_auth.py. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Hono } from 'hono';

import { createApp } from '../src/app.js';
import { BrowserManager } from '../src/browser.js';
import { checkWebSocketOrigin } from '../src/auth.js';
import { closeDb, createProfile, initDb } from '../src/db.js';

let dir: string;
let app: Hono;
let mgr: BrowserManager;

beforeEach(() => {
  delete process.env.AUTH_TOKEN;
  dir = mkdtempSync(path.join(tmpdir(), 'cbm-api-'));
  initDb(dir);
  mgr = new BrowserManager();
  app = createApp(mgr);
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.AUTH_TOKEN;
});

/** Response bodies are untyped JSON; the assertions below do the checking. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<any> => res.json();

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('profile CRUD', () => {
  it('lists nothing initially', async () => {
    const res = await app.request('/api/profiles');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('creates a profile with 201 and default status', async () => {
    const res = await app.request('/api/profiles', json({ name: 'New' }));
    expect(res.status).toBe(201);
    const b = await body(res);
    expect(b.name).toBe('New');
    expect(b.status).toBe('stopped');
    expect(b.vnc_ws_port).toBeNull();
    expect(b.cdp_url).toBeNull();
    expect(b.fingerprint_seed).toBeGreaterThanOrEqual(10000);
  });

  it('rejects an invalid body with 422', async () => {
    const res = await app.request('/api/profiles', json({ screen_width: 'wide' }));
    expect(res.status).toBe(422);
  });

  it('404s an unknown profile', async () => {
    expect((await app.request('/api/profiles/nope')).status).toBe(404);
  });

  it('fetches a created profile', async () => {
    const p = createProfile({ name: 'Fetch' });
    const res = await app.request(`/api/profiles/${p.id}`);
    expect((await body(res)).name).toBe('Fetch');
  });

  it('updates only supplied fields', async () => {
    const p = createProfile({ name: 'Before', notes: 'keep' });
    const res = await app.request(`/api/profiles/${p.id}`, {
      ...json({ name: 'After' }),
      method: 'PUT',
    });
    const b = await body(res);
    expect(b.name).toBe('After');
    expect(b.notes).toBe('keep');
  });

  it('404s an update to an unknown profile', async () => {
    const res = await app.request('/api/profiles/nope', {
      ...json({ name: 'X' }),
      method: 'PUT',
    });
    expect(res.status).toBe(404);
  });

  it('deletes a profile and its data dir', async () => {
    const p = createProfile({ name: 'Doomed' });
    const res = await app.request(`/api/profiles/${p.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await app.request(`/api/profiles/${p.id}`)).status).toBe(404);
  });

  it('404s a delete of an unknown profile', async () => {
    const res = await app.request('/api/profiles/nope', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('preserves tags through create and update', async () => {
    const created = await body(
      await app.request(
        '/api/profiles',
        json({ name: 'Tagged', tags: [{ tag: 'work', color: '#f00' }] })
      )
    );
    expect(created.tags).toHaveLength(1);

    const updated = await body(
      await app.request(`/api/profiles/${created.id}`, {
        ...json({ tags: [{ tag: 'other', color: null }] }),
        method: 'PUT',
      })
    );
    expect(updated.tags).toHaveLength(1);
    expect(updated.tags[0].tag).toBe('other');
  });
});

describe('launch / stop / status', () => {
  it('404s a launch of an unknown profile', async () => {
    const res = await app.request('/api/profiles/nope/launch', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('409s a launch of an already-running profile', async () => {
    const p = createProfile({ name: 'Running' });
    mgr.running.set(p.id, {
      profileId: p.id, context: {} as never, display: 100, wsPort: 6100, cdpPort: 5100,
    });
    const res = await app.request(`/api/profiles/${p.id}/launch`, { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it('404s a stop of a profile that is not running', async () => {
    const p = createProfile({ name: 'Idle' });
    const res = await app.request(`/api/profiles/${p.id}/stop`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('reports running status with ports once launched', async () => {
    const p = createProfile({ name: 'Running' });
    mgr.running.set(p.id, {
      profileId: p.id, context: {} as never, display: 100, wsPort: 6100, cdpPort: 5100,
    });
    const b = await body(await app.request(`/api/profiles/${p.id}/status`));
    expect(b).toEqual({
      status: 'running',
      vnc_ws_port: 6100,
      display: ':100',
      cdp_url: `/api/profiles/${p.id}/cdp`,
    });
  });

  it('surfaces running state in the list endpoint', async () => {
    const p = createProfile({ name: 'Running' });
    mgr.running.set(p.id, {
      profileId: p.id, context: {} as never, display: 100, wsPort: 6100, cdpPort: 5100,
    });
    const [first] = await body(await app.request('/api/profiles'));
    expect(first.status).toBe('running');
    expect(first.vnc_ws_port).toBe(6100);
  });

  it('400s a launch with an invalid proxy rather than 500', async () => {
    const p = createProfile({ name: 'BadProxy', proxy: 'ftp://host:21' });
    const res = await app.request(`/api/profiles/${p.id}/launch`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect((await body(res)).detail).toMatch(/Invalid proxy scheme/);
  });
});

describe('system status', () => {
  it('reports counts', async () => {
    createProfile({ name: 'A' });
    createProfile({ name: 'B' });
    const b = await body(await app.request('/api/status'));
    expect(b.profiles_total).toBe(2);
    expect(b.running_count).toBe(0);
    expect(typeof b.binary_version).toBe('string');
  });
});

describe('chromium binary', () => {
  // A local override is the only branch that reaches no network: every other
  // one asks GitHub for the newest release.
  const OVERRIDE = '/usr/local/bin/chrome';

  beforeEach(() => {
    process.env.CLOAKBROWSER_BINARY_PATH = OVERRIDE;
  });

  afterEach(() => {
    delete process.env.CLOAKBROWSER_BINARY_PATH;
  });

  it('reports an operator-supplied binary as not ours to update', async () => {
    const b = await body(await app.request('/api/binary'));
    expect(b.tier).toBe('override');
    expect(b.updatable).toBe(false);
    expect(b.binary_path).toBe(OVERRIDE);
    expect(b.update_available).toBe(false);
    expect(b.update.state).toBe('idle');
  });

  it('409s an update it cannot perform, rather than starting a doomed download', async () => {
    const res = await app.request('/api/binary/update', { method: 'POST' });
    expect(res.status).toBe(409);
    expect((await body(res)).detail).toMatch(/CLOAKBROWSER_BINARY_PATH/);
  });

  it('requires auth, unlike /api/status', async () => {
    process.env.AUTH_TOKEN = 'secret';
    const guarded = createApp(mgr);
    expect((await guarded.request('/api/binary')).status).toBe(401);
    expect(
      (await guarded.request('/api/binary/update', { method: 'POST' })).status
    ).toBe(401);
  });
});

describe('clipboard', () => {
  it('404s when the profile is not running', async () => {
    expect((await app.request('/api/profiles/nope/clipboard')).status).toBe(404);
    const res = await app.request('/api/profiles/nope/clipboard', json({ text: 'x' }));
    expect(res.status).toBe(404);
  });
});

describe('CDP discovery', () => {
  it('404s /cdp when not running', async () => {
    expect((await app.request('/api/profiles/nope/cdp')).status).toBe(404);
  });

  it('returns usage info when running', async () => {
    const p = createProfile({ name: 'R' });
    mgr.running.set(p.id, {
      profileId: p.id, context: {} as never, display: 100, wsPort: 6100, cdpPort: 5100,
    });
    const b = await body(await app.request(`/api/profiles/${p.id}/cdp`));
    expect(b.cdp_url).toBe(`/api/profiles/${p.id}/cdp`);
  });

  it('502s json/version when Chrome is unreachable', async () => {
    const p = createProfile({ name: 'R' });
    mgr.running.set(p.id, {
      profileId: p.id, context: {} as never, display: 100, wsPort: 6100, cdpPort: 59998,
    });
    const res = await app.request(`/api/profiles/${p.id}/cdp/json/version`);
    expect(res.status).toBe(502);
  });

  it('routes every json/list spelling Playwright probes', async () => {
    const p = createProfile({ name: 'R' });
    mgr.running.set(p.id, {
      profileId: p.id, context: {} as never, display: 100, wsPort: 6100, cdpPort: 59998,
    });
    for (const suffix of ['/cdp/json', '/cdp/json/', '/cdp/json/list', '/cdp/json/list/']) {
      const res = await app.request(`/api/profiles/${p.id}${suffix}`);
      // 502 (not 404) proves the route matched and tried to reach Chrome.
      expect(res.status, suffix).toBe(502);
    }
  });
});

describe('auth', () => {
  it('is open when AUTH_TOKEN is unset', async () => {
    expect((await app.request('/api/profiles')).status).toBe(200);
    const status = await body(await app.request('/api/auth/status'));
    expect(status.auth_required).toBe(false);
  });

  it('401s protected routes without a token', async () => {
    process.env.AUTH_TOKEN = 'secret';
    const guarded = createApp(mgr);
    expect((await guarded.request('/api/profiles')).status).toBe(401);
  });

  it('accepts a Bearer token', async () => {
    process.env.AUTH_TOKEN = 'secret';
    const guarded = createApp(mgr);
    const res = await guarded.request('/api/profiles', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects a wrong Bearer token', async () => {
    process.env.AUTH_TOKEN = 'secret';
    const guarded = createApp(mgr);
    const res = await guarded.request('/api/profiles', {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('accepts an auth_token cookie', async () => {
    process.env.AUTH_TOKEN = 'secret';
    const guarded = createApp(mgr);
    const res = await guarded.request('/api/profiles', {
      headers: { cookie: 'auth_token=secret' },
    });
    expect(res.status).toBe(200);
  });

  it('leaves the exempt endpoints reachable', async () => {
    process.env.AUTH_TOKEN = 'secret';
    const guarded = createApp(mgr);
    expect((await guarded.request('/api/auth/status')).status).toBe(200);
    expect((await guarded.request('/api/status')).status).toBe(200);
  });

  it('sets an httpOnly cookie on successful login', async () => {
    process.env.AUTH_TOKEN = 'secret';
    const guarded = createApp(mgr);
    const res = await guarded.request('/api/auth/login', json({ token: 'secret' }));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/auth_token=secret/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
  });

  it('401s login with a wrong token', async () => {
    process.env.AUTH_TOKEN = 'secret';
    const guarded = createApp(mgr);
    const res = await guarded.request('/api/auth/login', json({ token: 'nope' }));
    expect(res.status).toBe(401);
  });
});

describe('checkWebSocketOrigin', () => {
  it('allows a missing Origin (Playwright, curl)', () => {
    expect(checkWebSocketOrigin(undefined, 'localhost:8080')).toBe(true);
  });

  it('allows a matching Origin', () => {
    expect(checkWebSocketOrigin('http://localhost:8080', 'localhost:8080')).toBe(true);
  });

  it('rejects a mismatched Origin', () => {
    expect(checkWebSocketOrigin('http://evil.com', 'localhost:8080')).toBe(false);
  });

  it('normalizes default ports', () => {
    expect(checkWebSocketOrigin('https://example.com', 'example.com:443')).toBe(true);
    expect(checkWebSocketOrigin('http://example.com', 'example.com:80')).toBe(true);
  });

  it('rejects a malformed Origin', () => {
    expect(checkWebSocketOrigin('not-a-url', 'localhost:8080')).toBe(false);
  });
});

// ── Export / import ─────────────────────────────────────────────────────────

describe('profile export', () => {
  it('exports all profiles in an envelope, stripping install-specific fields', async () => {
    createProfile({ name: 'Alpha', platform: 'macos', tags: [{ tag: 'work', color: '#fff' }] });
    createProfile({ name: 'Beta', launch_args: ['--mute-audio'] });

    const res = await app.request('/api/profiles/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('astrabrowser-profiles.json');

    const b = await body(res);
    expect(b.version).toBe(1);
    expect(typeof b.exported_at).toBe('string');
    expect(b.profiles).toHaveLength(2);

    for (const entry of b.profiles) {
      // These are what make an export portable rather than a clone of one install.
      expect(entry).not.toHaveProperty('id');
      expect(entry).not.toHaveProperty('user_data_dir');
      expect(entry).not.toHaveProperty('created_at');
      expect(entry).not.toHaveProperty('updated_at');
    }

    const alpha = b.profiles.find((p: { name: string }) => p.name === 'Alpha');
    expect(alpha.platform).toBe('macos');
    expect(alpha.tags).toEqual([{ tag: 'work', color: '#fff' }]);
    const beta = b.profiles.find((p: { name: string }) => p.name === 'Beta');
    expect(beta.launch_args).toEqual(['--mute-audio']);
  });

  it('exports a single profile by id', async () => {
    const created = createProfile({ name: 'Just Me' });
    const res = await app.request(`/api/profiles/${created.id}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('just-me.json');
    const b = await body(res);
    expect(b.profiles).toHaveLength(1);
    expect(b.profiles[0].name).toBe('Just Me');
  });

  it('404s a single export for an unknown id', async () => {
    const res = await app.request('/api/profiles/nope/export');
    expect(res.status).toBe(404);
  });

  it('does not read "export" as a profile id', async () => {
    // The static route must win over /:id, or export 404s as a missing profile.
    const res = await app.request('/api/profiles/export');
    expect(res.status).toBe(200);
    expect(await body(res)).toHaveProperty('profiles');
  });
});

describe('profile import', () => {
  it('imports from the envelope shape', async () => {
    const res = await app.request(
      '/api/profiles/import',
      json({ version: 1, profiles: [{ name: 'Imported', platform: 'linux' }] })
    );
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ created: 1, skipped: [], renamed: [] });

    const list = await body(await app.request('/api/profiles'));
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Imported');
    expect(list[0].platform).toBe('linux');
    // A fresh install-specific identity is assigned, not carried in.
    expect(list[0].user_data_dir).toContain(list[0].id);
  });

  it('imports from a bare array', async () => {
    const res = await app.request('/api/profiles/import', json([{ name: 'Bare' }]));
    expect(res.status).toBe(200);
    expect((await body(res)).created).toBe(1);
  });

  it('renames rather than shadowing an existing name', async () => {
    createProfile({ name: 'Dup' });
    const res = await app.request('/api/profiles/import', json([{ name: 'Dup' }]));
    const b = await body(res);
    expect(b.created).toBe(1);
    expect(b.renamed).toEqual([{ from: 'Dup', to: 'Dup (imported)' }]);

    const names = (await body(await app.request('/api/profiles'))).map(
      (p: { name: string }) => p.name
    );
    expect(names).toContain('Dup');
    expect(names).toContain('Dup (imported)');
  });

  it('gives two identically-named entries in one batch distinct names', async () => {
    const res = await app.request(
      '/api/profiles/import',
      json([{ name: 'Same' }, { name: 'Same' }, { name: 'Same' }])
    );
    const b = await body(res);
    expect(b.created).toBe(3);

    const names = (await body(await app.request('/api/profiles'))).map(
      (p: { name: string }) => p.name
    );
    expect(new Set(names).size).toBe(3);
  });

  it('round-trips an export back into equivalent profiles', async () => {
    createProfile({
      name: 'Round Trip',
      platform: 'macos',
      screen_width: 1366,
      screen_height: 768,
      launch_args: ['--foo', '--bar'],
      headless: true,
      tags: [{ tag: 'a', color: '#111' }, { tag: 'b', color: null }],
    });

    const exported = await body(await app.request('/api/profiles/export'));

    // Delete, then re-import from the file we just produced.
    const original = (await body(await app.request('/api/profiles')))[0];
    await app.request(`/api/profiles/${original.id}`, { method: 'DELETE' });
    expect(await body(await app.request('/api/profiles'))).toEqual([]);

    const res = await app.request('/api/profiles/import', json(exported));
    expect((await body(res)).created).toBe(1);

    const restored = (await body(await app.request('/api/profiles')))[0];
    expect(restored.name).toBe('Round Trip');
    expect(restored.platform).toBe('macos');
    expect(restored.screen_width).toBe(1366);
    expect(restored.screen_height).toBe(768);
    expect(restored.launch_args).toEqual(['--foo', '--bar']);
    expect(restored.headless).toBe(true);
    expect(restored.tags).toHaveLength(2);
  });

  it('422s a payload that is not a profile list', async () => {
    expect((await app.request('/api/profiles/import', json({ nope: true }))).status).toBe(422);
    expect((await app.request('/api/profiles/import', json([{ noName: 1 }]))).status).toBe(422);
  });
});

// ── Force stop ──────────────────────────────────────────────────────────────

describe('force stop', () => {
  it('404s when the profile is not running', async () => {
    const created = createProfile({ name: 'Idle' });
    const res = await app.request(`/api/profiles/${created.id}/force-stop`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect((await body(res)).detail).toBe('Profile is not running');
  });

  it('evicts a tracked-but-dead profile', async () => {
    const created = createProfile({ name: 'Wedged' });
    // Stand in for a launched profile whose browser has since died.
    mgr.running.set(created.id, {
      profileId: created.id,
      context: {} as never,
      display: 100,
      wsPort: 6100,
      cdpPort: 5100,
    });

    const res = await app.request(`/api/profiles/${created.id}/force-stop`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: true });
    expect(mgr.running.has(created.id)).toBe(false);
  });
});

// ── Screenshots ─────────────────────────────────────────────────────────────

describe('screenshots', () => {
  it('404s for an unknown profile', async () => {
    const res = await app.request('/api/profiles/nope/screenshot');
    expect(res.status).toBe(404);
    expect((await body(res)).detail).toBe('Profile not found');
  });

  it('404s a stopped profile that has never been captured', async () => {
    const created = createProfile({ name: 'Never Run' });
    const res = await app.request(`/api/profiles/${created.id}/screenshot`);
    expect(res.status).toBe(404);
    expect((await body(res)).detail).toBe('No screenshot available');
  });
});

// ── Proxy test ──────────────────────────────────────────────────────────────

describe('proxy test', () => {
  it('422s a request with no proxy', async () => {
    expect((await app.request('/api/proxy/test', json({}))).status).toBe(422);
    expect((await app.request('/api/proxy/test', json({ proxy: '' }))).status).toBe(422);
  });

  it('reports a malformed proxy as a negative result, not an error status', async () => {
    const res = await app.request('/api/proxy/test', json({ proxy: 'http://nohost-no-port' }));
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.ok).toBe(false);
    expect(b.exit_ip).toBeNull();
    expect(b.error).toMatch(/port/i);
  });

  it('rejects an unsupported scheme before attempting a connection', async () => {
    const res = await app.request('/api/proxy/test', json({ proxy: 'ftp://host:21' }));
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.ok).toBe(false);
    expect(b.error).toMatch(/scheme/i);
  });
});
