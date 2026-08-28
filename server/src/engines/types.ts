/**
 * The seam between profile configuration and the browser that runs it.
 *
 * Two engines share one lifecycle (VNC display, port allocation, screenshots,
 * clipboard, stop/evict) but nothing of their configuration. A driver's whole
 * job is: given a profile row and a reserved display + port, produce a
 * BrowserContext and say how clients reach it. Everything engine-specific —
 * lock-file names, fingerprint flags vs. env-var config, CDP vs. Playwright
 * protocol — lives behind this interface and nowhere else.
 */

import type { BrowserContext } from 'playwright-core';

import type { AutomationProtocol, Engine, ProfileRow } from '../schemas.js';

export interface LaunchContext {
  /** X display the browser must render on, so the VNC view shows it. */
  display: number;
  /** Per-profile user-data directory, in the engine's own on-disk format. */
  userDataDir: string;
  /** Loopback port reserved for this session's automation endpoint. */
  port: number;
}

/**
 * Where an external client connects, and what protocol it must speak.
 *
 * `url` is the loopback endpoint this server proxies to. It is stored verbatim
 * rather than rebuilt from `port`: Playwright's launchServer reports an IPv6
 * endpoint (`ws://[::1]:PORT/...`) unless told otherwise, and reconstructing it
 * as 127.0.0.1 silently fails to connect.
 */
export interface AutomationEndpoint {
  protocol: AutomationProtocol;
  port: number;
  /** Absolute ws:// or http:// URL on loopback. */
  url: string;
}

export interface EngineSession {
  /**
   * Both engines yield one, which is what lets screenshot.ts and clipboard.ts
   * stay engine-agnostic.
   */
  context: BrowserContext;
  automation: AutomationEndpoint;
  /** Fires on crash, or when the user closes the browser from the VNC view. */
  onClose(cb: () => void): void;
  close(): Promise<void>;
}

export interface EngineDriver {
  readonly engine: Engine;
  /**
   * Reject a profile that cannot possibly launch, before anything is spawned.
   *
   * The manager calls this ahead of starting Xvnc. That ordering is deliberate:
   * the Python original validated after starting the X server, so a profile
   * with a bad proxy would spin up a display only to tear it straight back
   * down. It is also what lets the REST layer classify a bad proxy or a missing
   * seed as 400 rather than 500 — see USER_ERROR in profiles.ts.
   */
  validate(profile: ProfileRow): void;
  launch(profile: ProfileRow, ctx: LaunchContext): Promise<EngineSession>;
}
