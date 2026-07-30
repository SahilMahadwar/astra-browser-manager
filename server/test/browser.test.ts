/** Ported from backend/tests/test_browser_manager.py. */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  BASE_CDP_PORT,
  BrowserManager,
  buildFingerprintArgs,
  extractPort,
  normalizeProxy,
  validateProxy,
} from '../src/browser.js';
import { initProfileDefaults } from '../src/profile-defaults.js';
import type { ProfileRow } from '../src/schemas.js';

function profile(overrides: Partial<ProfileRow> = {}): ProfileRow {
  return {
    id: 'p1', name: 'Test', fingerprint_seed: 12345,
    proxy: null, timezone: null, locale: null, platform: 'windows',
    user_agent: null, screen_width: 1920, screen_height: 1080,
    gpu_vendor: null, gpu_renderer: null, hardware_concurrency: null,
    humanize: false, human_preset: 'default', headless: false, geoip: false,
    clipboard_sync: true, auto_launch: false, color_scheme: null,
    launch_args: [], notes: null, user_data_dir: '/tmp/x',
    created_at: 'now', updated_at: 'now', tags: [],
    ...overrides,
  };
}

// ── normalizeProxy ──────────────────────────────────────────────────────────

describe('normalizeProxy', () => {
  it('passes through http', () => {
    expect(normalizeProxy('http://user:pass@host:8080')).toBe('http://user:pass@host:8080');
  });
  it('passes through https', () => {
    expect(normalizeProxy('https://host:8080')).toBe('https://host:8080');
  });
  it('passes through socks5', () => {
    expect(normalizeProxy('socks5://host:1080')).toBe('socks5://host:1080');
  });
  it('converts host:port:user:pass', () => {
    expect(normalizeProxy('host:8080:user:pass')).toBe('http://user:pass@host:8080');
  });
  it('converts host:port', () => {
    expect(normalizeProxy('host:8080')).toBe('http://host:8080');
  });
  it('leaves a three-part string untouched', () => {
    expect(normalizeProxy('a:b:c')).toBe('a:b:c');
  });
  it('leaves a five-part string untouched', () => {
    expect(normalizeProxy('a:b:c:d:e')).toBe('a:b:c:d:e');
  });
  it('leaves an empty string untouched', () => {
    expect(normalizeProxy('')).toBe('');
  });
});

// ── validateProxy ───────────────────────────────────────────────────────────

describe('validateProxy', () => {
  it('accepts http with port', () => {
    expect(() => validateProxy('http://host:8080')).not.toThrow();
  });
  it('accepts socks5 with port', () => {
    expect(() => validateProxy('socks5://host:1080')).not.toThrow();
  });
  it('accepts credentials', () => {
    expect(() => validateProxy('http://u:p@host:8080')).not.toThrow();
  });
  it('rejects a bad scheme', () => {
    expect(() => validateProxy('ftp://host:21')).toThrow(/Invalid proxy scheme/);
  });
  it('rejects a missing port', () => {
    expect(() => validateProxy('http://host')).toThrow(/missing port/);
  });

  /**
   * Regression: `new URL()` normalises away a scheme's default port, so
   * `http://host:80` reports port ''. Python's urlparse returned 80, so
   * trusting URL.port rejected every proxy on :80 — which is what Webshare and
   * most rotating-proxy vendors use.
   */
  it('accepts an explicit :80 on http (the Webshare case)', () => {
    expect(() =>
      validateProxy('http://user-rotate:secret@p.webshare.io:80')
    ).not.toThrow();
  });

  it('accepts an explicit :443 on https', () => {
    expect(() => validateProxy('https://user:pass@host:443')).not.toThrow();
  });

  it('accepts credentials containing : and @', () => {
    expect(() => validateProxy('http://user:p@ss:word@host:80')).not.toThrow();
  });

  it('accepts an IPv6 literal with a port', () => {
    expect(() => validateProxy('http://[2001:db8::1]:8080')).not.toThrow();
  });

  it('still rejects an IPv6 literal with no port', () => {
    expect(() => validateProxy('http://[2001:db8::1]')).toThrow(/missing port/);
  });

  // new URL() already rejects ports outside 1-65535, for every scheme.
  it('rejects an out-of-range port', () => {
    expect(() => validateProxy('http://host:99999')).toThrow(/not parseable/);
    expect(() => validateProxy('socks5://host:70000')).toThrow(/not parseable/);
  });
});

describe('extractPort', () => {
  it.each([
    ['http://p.webshare.io:80', '80'],
    ['https://host:443', '443'],
    ['http://host:8080', '8080'],
    ['socks5://user:pass@host:1080', '1080'],
    ['http://user:pa:ss@host:3128', '3128'],
    ['http://[::1]:9050', '9050'],
  ])('reads the port from %s', (url, expected) => {
    expect(extractPort(url)).toBe(expected);
  });

  it.each([
    ['http://host'],
    ['http://user:pass@host'],
    ['http://[::1]'],
  ])('returns null when %s has no port', (url) => {
    expect(extractPort(url)).toBeNull();
  });
});

// ── buildFingerprintArgs ────────────────────────────────────────────────────

describe('buildFingerprintArgs', () => {
  it('always includes the base flags', () => {
    const args = buildFingerprintArgs(profile());
    expect(args).toContain('--disable-infobars');
    expect(args).toContain('--test-type');
    expect(args).toContain('--use-angle=swiftshader');
  });

  it('includes the seed', () => {
    expect(buildFingerprintArgs(profile({ fingerprint_seed: 42 }))).toContain(
      '--fingerprint=42'
    );
  });

  /**
   * Deviation from the Python original, which allowed a missing seed. Without
   * an explicit --fingerprint, cloakbrowser 0.5.2 substitutes its hardcoded
   * --fingerprint=59720, so every such profile would share one identity. The
   * DB column is NOT NULL, so this only fires if that invariant is broken.
   */
  it('refuses to launch without a seed rather than inheriting the shared default', () => {
    expect(() =>
      buildFingerprintArgs(profile({ fingerprint_seed: null as unknown as number }))
    ).toThrow(/no fingerprint_seed/);
  });

  it('includes the platform', () => {
    expect(buildFingerprintArgs(profile({ platform: 'macos' }))).toContain(
      '--fingerprint-platform=macos'
    );
  });

  it('includes GPU vendor and renderer', () => {
    const args = buildFingerprintArgs(
      profile({ gpu_vendor: 'Apple', gpu_renderer: 'Apple M1' })
    );
    expect(args).toContain('--fingerprint-gpu-vendor=Apple');
    expect(args).toContain('--fingerprint-gpu-renderer=Apple M1');
  });

  it('includes hardware concurrency, including zero', () => {
    expect(buildFingerprintArgs(profile({ hardware_concurrency: 8 }))).toContain(
      '--fingerprint-hardware-concurrency=8'
    );
    expect(buildFingerprintArgs(profile({ hardware_concurrency: 0 }))).toContain(
      '--fingerprint-hardware-concurrency=0'
    );
  });

  it('includes screen dimensions', () => {
    const args = buildFingerprintArgs(profile({ screen_width: 1280, screen_height: 720 }));
    expect(args).toContain('--fingerprint-screen-width=1280');
    expect(args).toContain('--fingerprint-screen-height=720');
  });

  it('omits GPU flags when unset', () => {
    const args = buildFingerprintArgs(profile());
    expect(args.some((a) => a.startsWith('--fingerprint-gpu'))).toBe(false);
  });
});

// ── CDP port allocation ─────────────────────────────────────────────────────

describe('allocateCdpPort', () => {
  const servers: Server[] = [];

  afterEach(() => {
    servers.splice(0).forEach((s) => s.close());
  });

  function occupy(port: number): Promise<void> {
    return new Promise((resolve) => {
      const s = createServer();
      servers.push(s);
      s.listen(port, '127.0.0.1', () => resolve());
    });
  }

  it('returns a port in range', async () => {
    const port = await new BrowserManager().allocateCdpPort();
    expect(port).toBeGreaterThanOrEqual(BASE_CDP_PORT);
    expect(port).toBeLessThan(BASE_CDP_PORT + 100);
  });

  it('skips an occupied port', async () => {
    await occupy(BASE_CDP_PORT);
    expect(await new BrowserManager().allocateCdpPort()).not.toBe(BASE_CDP_PORT);
  });

  it('advances the counter instead of reusing the same port', async () => {
    const mgr = new BrowserManager();
    const first = await mgr.allocateCdpPort();
    const second = await mgr.allocateCdpPort();
    expect(second).not.toBe(first);
  });
});

// ── initProfileDefaults ─────────────────────────────────────────────────────

describe('initProfileDefaults', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('creates bookmarks', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'cbm-prof-'));
    initProfileDefaults(dir);
    const bm = JSON.parse(readFileSync(path.join(dir, 'Default', 'Bookmarks'), 'utf8'));
    expect(bm.roots.bookmark_bar.children).toHaveLength(4);
    expect(bm.roots.bookmark_bar.children[0].name).toBe('Detection Tests');
  });

  it('creates preferences with DuckDuckGo', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'cbm-prof-'));
    initProfileDefaults(dir);
    const prefs = JSON.parse(readFileSync(path.join(dir, 'Default', 'Preferences'), 'utf8'));
    expect(prefs.default_search_provider_data.template_url_data.short_name).toBe('DuckDuckGo');
  });

  it('does not overwrite existing files', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'cbm-prof-'));
    initProfileDefaults(dir);
    const bmPath = path.join(dir, 'Default', 'Bookmarks');
    writeFileSync(bmPath, '{"custom":true}');
    initProfileDefaults(dir);
    expect(JSON.parse(readFileSync(bmPath, 'utf8'))).toEqual({ custom: true });
  });
});

// ── getStatus ───────────────────────────────────────────────────────────────

describe('getStatus', () => {
  it('reports stopped for an unknown profile', () => {
    expect(new BrowserManager().getStatus('nope')).toEqual({
      status: 'stopped',
      vnc_ws_port: null,
      display: null,
      cdp_url: null,
    });
  });

  it('reports running with ports for a live profile', () => {
    const mgr = new BrowserManager();
    mgr.running.set('p1', {
      profileId: 'p1',
      context: {} as never,
      display: 100,
      wsPort: 6100,
      cdpPort: 5100,
    });
    expect(mgr.getStatus('p1')).toEqual({
      status: 'running',
      vnc_ws_port: 6100,
      display: ':100',
      cdp_url: '/api/profiles/p1/cdp',
    });
  });
});
