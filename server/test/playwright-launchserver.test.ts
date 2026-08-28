/**
 * The playwright-core contract the Camoufox driver is built on.
 *
 * `firefox.launchServer()` carries two UNDOCUMENTED options that together make a
 * persistent profile and a remote endpoint possible at once:
 *
 *   _userDataDir    routes the launch through launchPersistentContext, so the
 *                   profile is a real directory that survives restarts.
 *   _sharedBrowser  puts the server in 'launchServerShared' mode, which sets
 *                   `isolateContexts: false` — without it a connecting client
 *                   sees only contexts it created, so the persistent one is
 *                   invisible and the client silently gets a blank browser.
 *
 * Both failure modes are silent and severe: profiles quietly stop persisting, or
 * clients quietly see nothing. `engines-camoufox.test.ts` greps the installed
 * bundle for these options, which catches outright removal; this file catches a
 * change in behaviour, which a grep cannot.
 *
 * Deliberately uses Playwright's own Firefox and NOT camoufox-js, so it needs no
 * Camoufox install and can therefore run in CI — where the driver-level
 * integration test cannot. Install a browser with
 * `npx playwright-core install firefox`.
 */

import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { firefox } from 'playwright-core';

/** The subset of Playwright's BrowserServer these tests use. */
interface LaunchedServer {
  wsEndpoint(): string;
  close(): Promise<void>;
}

/** `_userDataDir` / `_sharedBrowser` are not in the public types. */
type UnsafeLaunchServer = (opts: Record<string, unknown>) => Promise<LaunchedServer>;

function firefoxBinary(): string | null {
  try {
    const p = firefox.executablePath();
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

const describeIfBrowser = firefoxBinary() ? describe : describe.skip;

function launchServer(userDataDir: string, shared = true): Promise<LaunchedServer> {
  return (firefox.launchServer as unknown as UnsafeLaunchServer)({
    headless: true,
    host: '127.0.0.1',
    _userDataDir: userDataDir,
    _sharedBrowser: shared,
  });
}

function freshProfileDir(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'pw-launchserver-')), 'profile');
}

describeIfBrowser('playwright launchServer persistent + shared contract', () => {
  it('exposes the persistent context as contexts()[0]', async () => {
    const server = await launchServer(freshProfileDir());
    const client = await firefox.connect(server.wsEndpoint());
    try {
      // If _userDataDir were ignored, launchServer would fall back to launch()
      // and there would be no context here at all.
      expect(client.contexts()).toHaveLength(1);
      const page =
        client.contexts()[0]!.pages()[0] ?? (await client.contexts()[0]!.newPage());
      await page.goto('data:text/html,<title>ok</title>');
      expect(await page.title()).toBe('ok');
    } finally {
      await client.close();
      await server.close();
    }
  }, 120_000);

  it('lets a SECOND independent client see that same context', async () => {
    // This is what _sharedBrowser buys, and it is the property the manager
    // depends on: it holds one connection for screenshots and the clipboard
    // while the user's automation holds another.
    const server = await launchServer(freshProfileDir());
    const a = await firefox.connect(server.wsEndpoint());
    const b = await firefox.connect(server.wsEndpoint());
    try {
      const pageA =
        a.contexts()[0]!.pages()[0] ?? (await a.contexts()[0]!.newPage());
      await pageA.goto('data:text/html,<title>shared</title>');

      expect(b.contexts()).toHaveLength(1);
      const pageB = b.contexts()[0]!.pages()[0];
      expect(pageB, 'second client saw no pages').toBeTruthy();
      // Same window, not merely the same browser.
      expect(await pageB!.title()).toBe('shared');
    } finally {
      await a.close();
      await b.close();
      await server.close();
    }
  }, 120_000);

  it('keeps the browser alive when a client disconnects', async () => {
    // ignoreStopAndKill. A disconnecting automation client must not end the
    // session the VNC view is showing.
    const server = await launchServer(freshProfileDir());
    const a = await firefox.connect(server.wsEndpoint());
    const b = await firefox.connect(server.wsEndpoint());
    try {
      await b.close();
      expect(a.isConnected()).toBe(true);
      const page = a.contexts()[0]!.pages()[0] ?? (await a.contexts()[0]!.newPage());
      await page.goto('data:text/html,<title>still here</title>');
      expect(await page.title()).toBe('still here');
    } finally {
      await a.close();
      await server.close();
    }
  }, 120_000);

  it('persists cookies across a server restart on the same dir', async () => {
    const userDataDir = freshProfileDir();

    const first = await launchServer(userDataDir);
    const write = await firefox.connect(first.wsEndpoint());
    await write.contexts()[0]!.addCookies([
      {
        name: 'persist_probe',
        value: 'kept',
        domain: 'example.com',
        path: '/',
        // Session cookies are never written to disk; the expiry is what makes
        // this a real persistence check rather than a no-op.
        expires: Math.floor(Date.now() / 1000) + 86_400,
      },
    ]);
    await write.close();
    await first.close(); // graceful close is what flushes cookies.sqlite

    const second = await launchServer(userDataDir);
    const read = await firefox.connect(second.wsEndpoint());
    try {
      const cookies = await read.contexts()[0]!.cookies('http://example.com');
      expect(cookies.map((c) => c.name)).toContain('persist_probe');
    } finally {
      await read.close();
      await second.close();
    }
  }, 180_000);
});
