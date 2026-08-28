/**
 * Launch/stop/track browser instances per profile.
 * Ported from backend/browser_manager.py.
 *
 * Owns the parts every engine shares — the Xvnc display, the automation port,
 * the running registry, stop/evict/auto-launch — and delegates the launch
 * itself to an engine driver (src/engines/). Nothing engine-specific belongs
 * in this file.
 */

import { createServer } from 'node:net';
import type { BrowserContext } from 'playwright-core';

import { VNCManager } from './vnc.js';
import { driverFor } from './engines/index.js';
import { logger } from './logger.js';
import type { AutomationProtocol, Engine, ProfileRow } from './schemas.js';
import type { EngineSession } from './engines/types.js';

// Re-exported so existing importers (proxy-test.ts, the test suite) are
// unaffected by the extraction into proxy-config.ts / engines/chromium.ts.
export {
  CLIPBOARD_INIT_JS,
  describeProxy,
  extractPort,
  normalizeProxy,
  validateProxy,
} from './proxy-config.js';
export { buildFingerprintArgs } from './engines/chromium.js';

const log = logger('browser');

export const BASE_CDP_PORT = 5100;
export const CDP_PORT_RANGE = 100; // cycle 5100-5199 to dodge TIME_WAIT collisions

/**
 * Aliases. The range serves Chromium's CDP port and Camoufox's Playwright
 * server port alike; the CDP_* names are kept because they are part of the
 * module's existing surface and the test suite asserts on them.
 */
export const BASE_AUTOMATION_PORT = BASE_CDP_PORT;
export const AUTOMATION_PORT_RANGE = CDP_PORT_RANGE;

export interface RunningProfile {
  profileId: string;
  engine: Engine;
  context: BrowserContext;
  display: number;
  wsPort: number;
  /** Loopback port for this session's automation endpoint, whatever it speaks. */
  automationPort: number;
  protocol: AutomationProtocol;
  /** Loopback URL to proxy to, reported by the engine rather than rebuilt. */
  automationUrl: string;
  /**
   * Chromium's DevTools port, or null for an engine that has none. Callers that
   * genuinely need CDP (probeCdp, /json/list) must check this rather than
   * assume `automationPort` speaks CDP.
   */
  cdpPort: number | null;
  session: EngineSession;
}

export interface ProfileStatus {
  status: 'running' | 'stopped';
  engine: Engine | null;
  vnc_ws_port: number | null;
  display: string | null;
  /** Chromium only — kept as-is so existing CDP clients are unaffected. */
  cdp_url: string | null;
  automation_url: string | null;
  automation_protocol: AutomationProtocol | null;
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

    let port: number;
    try {
      port = await this.allocateCdpPort();
    } catch (err) {
      this.launching.delete(profileId);
      await this.vnc.stopVnc(display);
      throw err;
    }

    try {
      const driver = driverFor(profile.engine);

      // Before anything is spawned: a bad proxy or a missing seed must not cost
      // an X server that is torn straight back down, and must reach the caller
      // as a 400 rather than a 500.
      driver.validate(profile);

      // Xvnc must exist before the browser starts — the engines put their
      // window on this display and a missing one is a launch failure, not a
      // blank view. Config validation happens inside the driver, before it
      // spawns anything, so a bad proxy still fails fast.
      await this.vnc.startVnc(display, wsPort, profile.screen_width, profile.screen_height);

      const session = await driver.launch(profile, {
        display,
        userDataDir: profile.user_data_dir,
        port,
      });

      const running: RunningProfile = {
        profileId,
        engine: driver.engine,
        context: session.context,
        display,
        wsPort,
        automationPort: session.automation.port,
        protocol: session.automation.protocol,
        automationUrl: session.automation.url,
        cdpPort: session.automation.protocol === 'cdp' ? session.automation.port : null,
        session,
      };

      // Fires on crash, or when the user closes the browser from the VNC view.
      session.onClose(() => {
        void this.onBrowserClosed(profileId);
      });

      this.running.set(profileId, running);
      this.launching.delete(profileId);

      log.info(
        `Launched ${driver.engine} profile ${profileId} on display :${display} ` +
          `(wsPort=${wsPort}, automationPort=${port}, protocol=${session.automation.protocol})`
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

    log.info(`Stopping ${running.engine} profile ${profileId}`);
    try {
      // The driver decides what a clean shutdown means. For Camoufox that is
      // dropping our client leg and then stopping the browser process, which is
      // what flushes cookies.sqlite — closing the context alone would lose the
      // session the profile exists to keep.
      await running.session.close();
    } catch (err) {
      log.warn(`Error closing session for ${profileId}: ${String(err)}`);
    }
    await this.vnc.stopVnc(running.display);
  }

  getStatus(profileId: string): ProfileStatus {
    const running = this.running.get(profileId);
    if (running) {
      // cdp_url stays Chromium-only. Handing a Camoufox profile a /cdp path
      // would send an existing client into connectOverCDP against an endpoint
      // that cannot exist, which fails far less clearly than a null does.
      const isCdp = running.protocol === 'cdp';
      return {
        status: 'running',
        engine: running.engine,
        vnc_ws_port: running.wsPort,
        display: `:${running.display}`,
        cdp_url: isCdp ? `/api/profiles/${profileId}/cdp` : null,
        automation_url: `/api/profiles/${profileId}/${isCdp ? 'cdp' : 'pw'}`,
        automation_protocol: running.protocol,
      };
    }
    return {
      status: 'stopped',
      engine: null,
      vnc_ws_port: null,
      display: null,
      cdp_url: null,
      automation_url: null,
      automation_protocol: null,
    };
  }

  /** Drop a profile whose browser is gone but which never fired 'close'. */
  evict(profileId: string): void {
    const running = this.running.get(profileId);
    if (!running) return;
    this.running.delete(profileId);
    log.warn(`Evicted unresponsive profile ${profileId} (display :${running.display})`);
    void this.vnc.stopVnc(running.display);

    // Best effort, deliberately not awaited: eviction exists precisely because
    // the browser is unresponsive, so waiting on it is what we are escaping.
    // Camoufox additionally holds a WebSocket server on the automation port,
    // which would otherwise stay bound until the container restarts.
    void Promise.resolve()
      .then(() => running.session.close())
      .catch((err) => log.debug(`Evicted session ${profileId} did not close: ${String(err)}`));
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
