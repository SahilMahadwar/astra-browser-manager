/**
 * Camoufox (stealth Firefox) driver.
 *
 * Camoufox has no CDP. Firefox removed the CDP implementation outright in 141
 * (the `remote.active-protocols` pref was deleted with it) and Camoufox is
 * Firefox 152, so `connectOverCDP` is not merely unimplemented here — there is
 * nothing to connect to. Playwright itself throws
 * "CDP connections are only supported by Chromium". Camoufox's control channel
 * is Juggler over an OS pipe, which Playwright must own from spawn.
 *
 * That normally forces a choice between a persistent profile and a remote
 * endpoint — Camoufox's own Python wrapper raises rather than accept a
 * `user_data_dir` for `launch_server()`. The JS API does not have that limit:
 * `launchServer()` carries two undocumented options that together give both.
 *
 *   _userDataDir   routes the launch through launchPersistentContext(), so the
 *                  profile is a real directory on /data that survives restarts,
 *                  and serves the resulting browser over the normal Playwright
 *                  wsEndpoint.
 *   _sharedBrowser puts the server in 'launchServerShared' mode, which sets
 *                  `isolateContexts: false` on the dispatcher. WITHOUT IT a
 *                  connecting client sees only contexts it created itself, so
 *                  the persistent context is invisible and the client silently
 *                  gets a blank browser.
 *
 * The same mode sets `ignoreStopAndKill: true`, so a client calling
 * browser.close() cannot take the profile down, and `maxConnections: Infinity`,
 * so this manager and the user's automation can hold connections at once.
 *
 * Both options are undocumented internals. test/engines-camoufox.test.ts pins
 * them, so a playwright-core bump fails loudly instead of quietly degrading
 * every Camoufox profile to a throwaway one.
 */

import { rmSync } from 'node:fs';
import path from 'node:path';
import { CLIPBOARD_INIT_JS, describeProxy, extractPort, normalizeProxy, validateProxy } from '../proxy-config.js';
import { initCamoufoxProfileDefaults } from '../profile-defaults.js';
import { camoufoxConfigSchema } from '../schemas.js';
import { logger } from '../logger.js';
import type { ProfileRow } from '../schemas.js';
import type { EngineDriver, EngineSession, LaunchContext } from './types.js';

const log = logger('browser');

/**
 * Playwright's proxy object form. Firefox takes credentials natively, unlike
 * Chromium — there is no CDP auth interceptor and no local relay needed.
 */
export interface PlaywrightProxy {
  server: string;
  username?: string;
  password?: string;
}

/**
 * Split a normalized proxy URL into Playwright's `{server, username, password}`.
 *
 * The credentials must be lifted out of the authority rather than left inline:
 * Firefox treats the whole string as the host when they are embedded, so an
 * inline-credential URL silently fails to connect.
 */
export function toPlaywrightProxy(normalized: string): PlaywrightProxy {
  const parsed = new URL(normalized);
  const port = parsed.port || extractPort(normalized);
  const server = `${parsed.protocol}//${parsed.hostname}${port ? `:${port}` : ''}`;
  const proxy: PlaywrightProxy = { server };
  if (parsed.username) proxy.username = decodeURIComponent(parsed.username);
  if (parsed.password) proxy.password = decodeURIComponent(parsed.password);
  return proxy;
}

/** Path component of the Playwright endpoint. Namespaced per profile for logs. */
export function wsPathFor(profileId: string): string {
  return `/pw/${profileId}`;
}

export const camoufoxDriver: EngineDriver = {
  engine: 'camoufox',

  validate(profile: ProfileRow): void {
    // Throws a ZodError naming the offending key if engine_config is malformed.
    camoufoxConfigSchema.parse(profile.engine_config ?? {});
    if (profile.proxy) validateProxy(normalizeProxy(profile.proxy));
  },

  async launch(profile: ProfileRow, ctx: LaunchContext): Promise<EngineSession> {
    const { display, userDataDir, port } = ctx;

    // Firefox's lock files, not Chromium's Singleton* set. A crashed session
    // leaves these behind and the next launch refuses the profile as in use.
    for (const lock of ['.parentlock', 'lock']) {
      rmSync(path.join(userDataDir, lock), { force: true });
    }

    initCamoufoxProfileDefaults(userDataDir);

    const cfg = camoufoxConfigSchema.parse(profile.engine_config ?? {});

    /**
     * Route the shared user_agent/timezone columns through Camoufox's own
     * config rather than Playwright's context overrides.
     *
     * Playwright's `userAgent` option only changes navigator.userAgent and the
     * request header; it does not touch the dozen related values Camoufox
     * derives (oscpu, platform, appVersion, client hints). The result is a
     * fingerprint that disagrees with itself, which is a stronger detection
     * signal than the default UA ever was.
     */
    const overrides: Record<string, unknown> = { ...cfg.config };
    if (profile.user_agent) {
      overrides['navigator.userAgent'] = profile.user_agent;
      overrides['headers.User-Agent'] = profile.user_agent;
    }
    if (profile.timezone) overrides['timezone'] = profile.timezone;

    /**
     * Make the reported screen match the display the profile actually renders
     * on. Camoufox's bundled presets otherwise supply the screen of whatever
     * real device the preset came from — a 1280x800 Xvnc session claiming a
     * 5120x1440 monitor, which is incoherent and makes the profile's own
     * screen-size setting a no-op for this engine. A raw `config` override from
     * the user still wins.
     */
    if (profile.screen_width && profile.screen_height) {
      const screen: Record<string, number> = {
        'screen.width': profile.screen_width,
        'screen.height': profile.screen_height,
        'screen.availWidth': profile.screen_width,
        'screen.availHeight': profile.screen_height,
        'screen.availLeft': 0,
        'screen.availTop': 0,
      };
      for (const [key, value] of Object.entries(screen)) {
        if (!(key in overrides)) overrides[key] = value;
      }
    }

    const rawProxy = profile.proxy || null;
    let proxy: PlaywrightProxy | undefined;
    if (rawProxy) {
      const normalized = normalizeProxy(rawProxy);
      validateProxy(normalized);
      log.debug(`Profile ${profile.id} proxy: ${describeProxy(normalized)}`);
      proxy = toPlaywrightProxy(normalized);
    }

    const { launchOptions } = await import('camoufox-js');
    const { firefox } = await import('playwright-core');

    // camoufox-js turns these into a BrowserForge fingerprint serialised as
    // chunked CAMOU_CONFIG_1..N env vars, plus Firefox prefs and args.
    const opts = (await launchOptions({
      // Defaults to headful, like every other profile: the window renders onto
      // this profile's Xvnc display and that is what the VNC view shows. We
      // never use Camoufox's own headless:'virtual' mode, which would start a
      // second Xvfb (defaulting to a 1x1 screen — camoufox issue #458).
      headless: Boolean(profile.headless),
      proxy,
      os: cfg.os ?? undefined,
      humanize: cfg.humanize,
      geoip: cfg.geoip,
      locale: profile.locale || undefined,
      window: [profile.screen_width, profile.screen_height],
      block_images: cfg.block_images,
      block_webrtc: cfg.block_webrtc,
      block_webgl: cfg.block_webgl,
      enable_cache: cfg.enable_cache,
      disable_coop: cfg.disable_coop,
      main_world_eval: cfg.main_world_eval,
      fingerprint_preset: cfg.fingerprint_preset,
      exclude_default_addons: cfg.exclude_default_addons,
      fonts: cfg.fonts.length > 0 ? cfg.fonts : undefined,
      webgl_config:
        cfg.webgl_vendor && cfg.webgl_renderer
          ? ([cfg.webgl_vendor, cfg.webgl_renderer] as [string, string])
          : undefined,
      config: Object.keys(overrides).length > 0 ? overrides : undefined,
    } as never)) as Record<string, unknown>;

    // Mirrors CLOAKBROWSER_BINARY_PATH on the Chromium side: lets an operator
    // point at their own build.
    //
    // It swaps the executable ONLY, and it does not remove the need for an
    // installed Camoufox. launchOptions() above has already called
    // installedVerStr(), which reads `version.json` out of the managed install
    // to get the Firefox major version it generates the fingerprint against — so
    // without an install it throws before ever reaching this line, whatever
    // binary you point at.
    const executableOverride = process.env.CAMOUFOX_BINARY_PATH;
    if (executableOverride) opts.executablePath = executableOverride;

    const server = await (firefox as unknown as {
      launchServer(o: Record<string, unknown>): Promise<CamoufoxServer>;
    }).launchServer({
      ...opts,
      // opts.env carries CAMOU_CONFIG_1..N — the whole fingerprint. It must be
      // merged with the ambient env AND with DISPLAY, or the window never
      // reaches this profile's virtual screen and the VNC view stays empty.
      env: { ...process.env, ...(opts.env as Record<string, string> | undefined), DISPLAY: `:${display}` },
      firefoxUserPrefs: {
        ...(opts.firefoxUserPrefs as Record<string, unknown> | undefined),
        // Firefox's remote agent otherwise rewrites a batch of prefs it deems
        // suitable for automation, mutating the surface Camoufox just spoofed.
        'remote.prefs.recommended': false,
      },
      // Let the page fill the real window instead of Playwright's fixed 1280x720
      // default. Camoufox's own API does the same whenever the window size is
      // spoofed, and its docs tie a mismatch here to Juggler deadlocks.
      noDefaultViewport: true,
      colorScheme: profile.color_scheme || undefined,
      _userDataDir: userDataDir,
      _sharedBrowser: true,
      host: '127.0.0.1', // loopback only; reachable solely through our proxy
      port,
      wsPath: wsPathFor(profile.id),
    });

    // Use the reported endpoint verbatim. Playwright reports an IPv6 endpoint
    // (ws://[::1]:PORT/...) when no host is given, and rebuilding it by hand as
    // 127.0.0.1 is a connection failure that looks like a dead browser.
    const wsEndpoint = server.wsEndpoint();

    const browser = await firefox.connect(wsEndpoint);
    const context = browser.contexts()[0];
    if (!context) {
      await server.close().catch(() => {});
      throw new Error(
        `Camoufox launched for profile ${profile.id} but exposed no persistent ` +
          `context. This means launchServer ignored _userDataDir/_sharedBrowser — ` +
          `check the installed playwright-core version.`
      );
    }

    await context.addInitScript(CLIPBOARD_INIT_JS);
    for (const p of context.pages()) {
      try {
        await p.evaluate(CLIPBOARD_INIT_JS);
      } catch (err) {
        log.debug(`Clipboard init failed on existing page: ${String(err)}`);
      }
    }

    return {
      context,
      automation: { protocol: 'playwright-firefox', port, url: wsEndpoint },
      // The browser process dying is the real signal. A client disconnecting is
      // not: ignoreStopAndKill means client closes cannot end the session.
      onClose: (cb) => server.on('close', cb),
      close: async () => {
        // Close our own client leg first so the graceful browser shutdown is
        // not racing an open connection, then stop the process — that is what
        // flushes cookies.sqlite, which is the whole point of persistence.
        await browser.close().catch(() => {});
        await server.close();
      },
    };
  },
};

/** The subset of Playwright's BrowserServer this driver relies on. */
interface CamoufoxServer {
  wsEndpoint(): string;
  close(): Promise<void>;
  on(event: 'close', cb: () => void): void;
}
