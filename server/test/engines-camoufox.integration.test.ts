/**
 * End-to-end exercise of the Camoufox driver.
 *
 * Substitutes Playwright's stock Firefox for the Camoufox binary via
 * CAMOUFOX_BINARY_PATH. That leaves Camoufox's own fingerprint injection
 * unverified — only the real binary can prove that — but it does cover
 * everything this repo actually owns: option assembly, the undocumented
 * launchServer options, the endpoint we hand out, and the guarantee that an
 * external client attaches to the SAME persistent context the manager holds
 * rather than a fresh one.
 *
 * Skipped when no Firefox is installed, so a checkout without browsers still
 * runs the suite. Install one with `npx playwright-core install firefox`.
 */

import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { firefox } from 'playwright-core';

import { camoufoxDriver } from '../src/engines/camoufox.js';
import type { EngineSession } from '../src/engines/types.js';
import type { ProfileRow } from '../src/schemas.js';

function firefoxBinary(): string | null {
  try {
    const p = firefox.executablePath();
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

const binary = firefoxBinary();
const describeIfBrowser = binary ? describe : describe.skip;

function profileRow(userDataDir: string): ProfileRow {
  return {
    id: 'integration-profile',
    name: 'Integration',
    engine: 'camoufox',
    engine_config: { os: 'windows', humanize: true },
    fingerprint_seed: 1,
    proxy: null,
    timezone: null,
    locale: 'en-US',
    platform: 'windows',
    user_agent: null,
    screen_width: 1280,
    screen_height: 800,
    gpu_vendor: null,
    gpu_renderer: null,
    hardware_concurrency: null,
    humanize: false,
    human_preset: 'default',
    headless: false,
    geoip: false,
    clipboard_sync: true,
    auto_launch: false,
    color_scheme: null,
    launch_args: [],
    notes: null,
    user_data_dir: userDataDir,
    created_at: '',
    updated_at: '',
    tags: [],
  };
}

describeIfBrowser('camoufox driver (integration)', () => {
  let session: EngineSession;
  let userDataDir: string;
  const previousOverride = process.env.CAMOUFOX_BINARY_PATH;

  beforeAll(async () => {
    process.env.CAMOUFOX_BINARY_PATH = binary!;
    userDataDir = path.join(mkdtempSync(path.join(tmpdir(), 'camoufox-it-')), 'profile');
    session = await camoufoxDriver.launch(profileRow(userDataDir), {
      display: 0,
      userDataDir,
      // Well outside the manager's 5100-5199 range so a live dev server on the
      // same machine cannot collide with this test.
      port: 5399,
    });
  }, 120_000);

  afterAll(async () => {
    await session?.close().catch(() => {});
    if (previousOverride === undefined) delete process.env.CAMOUFOX_BINARY_PATH;
    else process.env.CAMOUFOX_BINARY_PATH = previousOverride;
  });

  it('gives the page the real window rather than a fixed 1280x720 viewport', async () => {
    // noDefaultViewport. Without it, Playwright clamps every page to its own
    // default and the rendered area stops matching the window the VNC view and
    // the spoofed screen size both describe.
    // viewportSize() is null exactly when noDefaultViewport took effect. The
    // rendered width is not a usable signal — the real window can happen to be
    // 1280 wide, which is also Playwright's default.
    const page = session.context.pages()[0]!;
    expect(page.viewportSize()).toBeNull();
  }, 60_000);

  it('reports a playwright endpoint on the allocated port', () => {
    expect(session.automation.protocol).toBe('playwright-firefox');
    expect(session.automation.port).toBe(5399);
    expect(session.automation.url).toBe('ws://127.0.0.1:5399/pw/integration-profile');
  });

  it('gives the manager a persistent context to work with', () => {
    // screenshot.ts and clipboard.ts both operate through this handle, so a
    // driver that returned no context would break them silently.
    expect(session.context).toBeTruthy();
    expect(session.context.pages().length).toBeGreaterThan(0);
  });

  it('lets an external client attach to the SAME context, not a new one', async () => {
    // This is the whole point of _sharedBrowser. Without it the client gets an
    // isolated view and sees none of the profile's state.
    const client = await firefox.connect(session.automation.url);
    try {
      const context = client.contexts()[0];
      expect(context).toBeTruthy();

      const page = context!.pages()[0] ?? (await context!.newPage());
      await page.goto('data:text/html,<title>driven</title>');
      expect(await page.title()).toBe('driven');

      // The init script was injected by the manager. Seeing it here proves the
      // two connections share one context rather than merely one browser.
      // Evaluated as a string so this file needs no DOM lib in tsconfig.
      expect(await page.evaluate('typeof window.__clipboardText')).toBe('string');
    } finally {
      await client.close();
    }
  }, 60_000);

  it('survives an automation client disconnecting', async () => {
    // ignoreStopAndKill: a client going away must not end the session that the
    // VNC view is showing.
    const client = await firefox.connect(session.automation.url);
    await client.close();
    expect(session.context.pages()[0]?.isClosed()).toBe(false);
  }, 60_000);

  it('persists cookies across a stop and relaunch', async () => {
    await session.context.addCookies([
      {
        name: 'persist_probe',
        value: 'yes',
        domain: 'example.com',
        path: '/',
        // Session cookies are never written to disk; an expiry is what makes
        // this a real persistence check rather than a no-op.
        expires: Math.floor(Date.now() / 1000) + 86_400,
      },
    ]);
    await session.close();

    session = await camoufoxDriver.launch(profileRow(userDataDir), {
      display: 0,
      userDataDir,
      port: 5399,
    });
    const cookies = await session.context.cookies('http://example.com');
    expect(cookies.map((c) => c.name)).toContain('persist_probe');
  }, 120_000);
});
