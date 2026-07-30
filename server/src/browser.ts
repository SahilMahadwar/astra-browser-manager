/**
 * Launch/stop/track CloakBrowser instances per profile.
 * Ported from backend/browser_manager.py.
 */

import { createServer } from 'node:net';
import { rmSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext } from 'playwright-core';

import { VNCManager } from './vnc.js';
import { initProfileDefaults } from './profile-defaults.js';
import { logger } from './logger.js';
import type { ProfileRow } from './schemas.js';

const log = logger('browser');

export const BASE_CDP_PORT = 5100;
export const CDP_PORT_RANGE = 100; // cycle 5100-5199 to dodge TIME_WAIT collisions

/**
 * Convert common proxy formats to http://user:pass@host:port.
 * Accepts an already-valid URL, host:port:user:pass, or host:port.
 */
export function normalizeProxy(raw: string): string {
  if (/^(https?|socks5):\/\//.test(raw)) return raw;
  const parts = raw.split(':');
  if (parts.length === 4) {
    const [host, port, user, passwd] = parts;
    return `http://${user}:${passwd}@${host}:${port}`;
  }
  if (parts.length === 2) return `http://${raw}`;
  return raw;
}

/**
 * Read the port straight out of a URL's authority.
 *
 * `new URL()` normalises away the default port for a scheme, so
 * `http://host:80` and `https://host:443` both report `port === ''` — unlike
 * Python's `urlparse`, which the original implementation relied on. Trusting
 * `URL.port` therefore rejected every HTTP proxy on :80 (Webshare and most
 * rotating-proxy vendors use exactly that).
 *
 * Handles userinfo containing ':' and '@', plus IPv6 literals.
 */
export function extractPort(url: string): string | null {
  const schemeEnd = url.indexOf('://');
  if (schemeEnd === -1) return null;

  const authority = url.slice(schemeEnd + 3).split(/[/?#]/)[0];
  // Passwords may contain ':' and '@', so the host starts after the LAST '@'.
  const at = authority.lastIndexOf('@');
  const hostPort = at === -1 ? authority : authority.slice(at + 1);

  if (hostPort.startsWith('[')) {
    // IPv6 literal: [::1]:8080
    const close = hostPort.indexOf(']');
    if (close === -1) return null;
    const rest = hostPort.slice(close + 1);
    return rest.startsWith(':') && /^\d+$/.test(rest.slice(1)) ? rest.slice(1) : null;
  }

  const colon = hostPort.lastIndexOf(':');
  if (colon === -1) return null;
  const port = hostPort.slice(colon + 1);
  return /^\d+$/.test(port) && port.length > 0 ? port : null;
}

/** Validate that a normalized proxy URL has scheme, host, and port. */
export function validateProxy(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Proxy URL is not parseable: ${url}`);
  }
  const scheme = parsed.protocol.replace(':', '');
  if (!['http', 'https', 'socks5'].includes(scheme)) {
    throw new Error(
      `Invalid proxy scheme '${scheme}'. Must be http, https, or socks5.`
    );
  }
  if (!parsed.hostname) throw new Error(`Proxy URL missing hostname: ${url}`);

  // parsed.port is empty for a scheme's default port, so fall back to the
  // raw authority before declaring the port missing. No range check is needed:
  // `new URL()` already rejects ports outside 1-65535 for every scheme.
  if (!parsed.port && !extractPort(url)) {
    throw new Error(`Proxy URL missing port: ${url}`);
  }
}

/**
 * Describe a proxy for the log without leaking the password.
 *
 * Whether credentials survived normalization decides which auth path
 * cloakbrowser takes — inline `--proxy-server` creds, or Playwright's CDP auth
 * interceptor, which prompts on some proxies. When a session unexpectedly asks
 * for proxy credentials, this line is what says which one was in play.
 */
export function describeProxy(url: string): string {
  try {
    const parsed = new URL(url);
    const port = parsed.port || extractPort(url) || '?';
    const creds = parsed.username ? 'with credentials' : 'no credentials';
    return `${parsed.protocol}//${parsed.hostname}:${port} (${creds})`;
  } catch {
    return '(unparseable)';
  }
}

/**
 * Injected into every page so GET /clipboard can read what the user copied.
 * Chrome under KasmVNC never writes to the X11 clipboard, so xclip can't see it.
 */
export const CLIPBOARD_INIT_JS = `
    window.__clipboardText = '';
    document.addEventListener('copy', () => {
        const sel = window.getSelection();
        if (sel) window.__clipboardText = sel.toString();
    });
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'c' && !e.altKey && !e.shiftKey) {
            const sel = window.getSelection();
            if (sel && sel.toString()) window.__clipboardText = sel.toString();
        }
    });
`;

export interface RunningProfile {
  profileId: string;
  context: BrowserContext;
  display: number;
  wsPort: number;
  cdpPort: number;
}

export interface ProfileStatus {
  status: 'running' | 'stopped';
  vnc_ws_port: number | null;
  display: string | null;
  cdp_url: string | null;
}

/**
 * Build extra Chromium args from a profile's fingerprint settings.
 *
 * Critical: cloakbrowser's own defaults include `--fingerprint=59720` and
 * `--fingerprint-platform=windows`. Its arg merge lets ours win by flag name,
 * but if we ever omitted these, every such profile would silently share one
 * constant fingerprint — exactly the account-linking the product prevents.
 * The seed is therefore asserted, not assumed.
 */
export function buildFingerprintArgs(profile: ProfileRow): string[] {
  if (profile.fingerprint_seed === null || profile.fingerprint_seed === undefined) {
    throw new Error(
      `Profile ${profile.id} has no fingerprint_seed — refusing to launch, as it ` +
        `would inherit cloakbrowser's shared default fingerprint.`
    );
  }

  const args: string[] = [
    '--disable-infobars',
    '--test-type', // suppress the "unsupported flag: --no-sandbox" warning
    '--use-angle=swiftshader', // software GL for VNC (no GPU in container)
    `--fingerprint=${profile.fingerprint_seed}`,
  ];

  if (profile.platform) args.push(`--fingerprint-platform=${profile.platform}`);
  if (profile.gpu_vendor) args.push(`--fingerprint-gpu-vendor=${profile.gpu_vendor}`);
  if (profile.gpu_renderer) args.push(`--fingerprint-gpu-renderer=${profile.gpu_renderer}`);
  if (profile.hardware_concurrency !== null && profile.hardware_concurrency !== undefined) {
    args.push(`--fingerprint-hardware-concurrency=${profile.hardware_concurrency}`);
  }
  if (profile.screen_width) args.push(`--fingerprint-screen-width=${profile.screen_width}`);
  if (profile.screen_height) args.push(`--fingerprint-screen-height=${profile.screen_height}`);

  return args;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

export class BrowserManager {
  readonly running = new Map<string, RunningProfile>();
  readonly vnc = new VNCManager();

  private launching = new Set<string>();
  private nextCdpPort = BASE_CDP_PORT;

  /**
   * Find a free CDP port using a rotating counter. Scanning from the base each
   * time would keep hitting ports in TIME_WAIT after a fast relaunch.
   */
  async allocateCdpPort(): Promise<number> {
    for (let i = 0; i < CDP_PORT_RANGE; i++) {
      const port = this.nextCdpPort;
      this.nextCdpPort =
        BASE_CDP_PORT + ((this.nextCdpPort + 1 - BASE_CDP_PORT) % CDP_PORT_RANGE);
      if (await portFree(port)) return port;
    }
    throw new Error(
      `No free CDP ports available in range ${BASE_CDP_PORT}-${BASE_CDP_PORT + CDP_PORT_RANGE - 1}`
    );
  }

  async launch(profile: ProfileRow): Promise<RunningProfile> {
    const profileId = profile.id;

    if (this.running.has(profileId) || this.launching.has(profileId)) {
      throw new Error(`Profile ${profileId} is already running`);
    }
    this.launching.add(profileId);

    const { display, wsPort } = this.vnc.allocate();

    let cdpPort: number;
    try {
      cdpPort = await this.allocateCdpPort();
    } catch (err) {
      this.launching.delete(profileId);
      await this.vnc.stopVnc(display);
      throw err;
    }

    try {
      // Clear Chromium lock files left by a previous crash.
      const userDataDir = profile.user_data_dir;
      for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        rmSync(path.join(userDataDir, lock), { force: true });
      }

      initProfileDefaults(userDataDir);

      // Validate configuration before spawning anything. The Python original
      // did this after starting Xvnc, so a profile with a bad proxy would spin
      // up an X server only to tear it straight back down.
      const args = [
        ...buildFingerprintArgs(profile),
        ...(profile.launch_args ?? []),
        `--remote-debugging-port=${cdpPort}`,
      ];

      const rawProxy = profile.proxy || null;
      const proxy = rawProxy ? normalizeProxy(rawProxy) : undefined;
      if (proxy) {
        validateProxy(proxy);
        log.debug(`Profile ${profileId} proxy: ${describeProxy(proxy)}`);
      }

      await this.vnc.startVnc(display, wsPort, profile.screen_width, profile.screen_height);

      const { launchPersistentContext } = await import('cloakbrowser');

      const context: BrowserContext = await launchPersistentContext({
        userDataDir,
        headless: Boolean(profile.headless),
        proxy,
        args,
        timezone: profile.timezone || undefined,
        locale: profile.locale || undefined,
        humanize: Boolean(profile.humanize),
        humanPreset: (profile.human_preset as 'default' | 'careful') || 'default',
        geoip: Boolean(profile.geoip),
        colorScheme: (profile.color_scheme as 'light' | 'dark' | 'no-preference') || undefined,
        userAgent: profile.user_agent || undefined,
        viewport: {
          width: profile.screen_width,
          // 133px accounts for browser chrome height; keep in sync with the
          // Python original or the page viewport will not match the window.
          height: profile.screen_height - 133,
        },
        // DISPLAY must reach the child process — this is what puts Chromium on
        // the profile's virtual screen. cloakbrowser forwards launchOptions.env
        // through its license-key env merge (verified against 0.5.2).
        launchOptions: { env: { ...process.env, DISPLAY: `:${display}` } },
      });

      await context.addInitScript(CLIPBOARD_INIT_JS);
      // Pages opened before addInitScript (about:blank) need it injected directly.
      for (const p of context.pages()) {
        try {
          await p.evaluate(CLIPBOARD_INIT_JS);
        } catch (err) {
          log.debug(`Clipboard init failed on existing page: ${String(err)}`);
        }
      }

      const running: RunningProfile = { profileId, context, display, wsPort, cdpPort };

      // Fires on crash, or when the user closes Chrome from inside the VNC view.
      context.on('close', () => {
        void this.onBrowserClosed(profileId);
      });

      this.running.set(profileId, running);
      this.launching.delete(profileId);

      log.info(
        `Launched profile ${profileId} on display :${display} (wsPort=${wsPort}, cdpPort=${cdpPort})`
      );
      return running;
    } catch (err) {
      this.launching.delete(profileId);
      await this.vnc.stopVnc(display);
      throw err;
    }
  }

  private async onBrowserClosed(profileId: string): Promise<void> {
    const running = this.running.get(profileId);
    if (!running) return;
    this.running.delete(profileId);

    log.info(`Browser closed for profile ${profileId}, cleaning up`);
    await this.vnc.stopVnc(running.display);
  }

  async stop(profileId: string): Promise<void> {
    // Remove first so onBrowserClosed() finds nothing left to clean up.
    const running = this.running.get(profileId);
    if (!running) return;
    this.running.delete(profileId);

    log.info(`Stopping profile ${profileId}`);
    try {
      await running.context.close();
    } catch (err) {
      log.warn(`Error closing context for ${profileId}: ${String(err)}`);
    }
    await this.vnc.stopVnc(running.display);
  }

  getStatus(profileId: string): ProfileStatus {
    const running = this.running.get(profileId);
    if (running) {
      return {
        status: 'running',
        vnc_ws_port: running.wsPort,
        display: `:${running.display}`,
        cdp_url: `/api/profiles/${profileId}/cdp`,
      };
    }
    return { status: 'stopped', vnc_ws_port: null, display: null, cdp_url: null };
  }

  /** Drop a profile whose browser is gone but which never fired 'close'. */
  evict(profileId: string): void {
    const running = this.running.get(profileId);
    if (!running) return;
    this.running.delete(profileId);
    log.warn(`Evicted unresponsive profile ${profileId} (display :${running.display})`);
    void this.vnc.stopVnc(running.display);
  }

  async cleanupAll(): Promise<void> {
    for (const pid of [...this.running.keys()]) await this.stop(pid);
    await this.vnc.cleanupAll();
  }

  async cleanupStale(): Promise<void> {
    await this.vnc.cleanupStale();
  }

  /** Launch every profile flagged auto_launch. Called on startup. */
  async autoLaunchAll(profiles: ProfileRow[]): Promise<void> {
    const autoProfiles = profiles.filter((p) => p.auto_launch);
    if (autoProfiles.length === 0) {
      log.info('No profiles configured for auto-launch');
      return;
    }

    log.info(`Auto-launching ${autoProfiles.length} profile(s)...`);
    for (const profile of autoProfiles) {
      try {
        await withTimeout(this.launch(profile), 60_000);
        log.info(`Auto-launched profile ${profile.name} (${profile.id})`);
      } catch (err) {
        log.error(
          `Auto-launch failed for profile ${profile.name} (${profile.id}): ${String(err)}`
        );
      }
    }
    log.info(`Auto-launch complete: ${this.running.size} running`);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
    ),
  ]);
}
