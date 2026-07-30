/**
 * Profile operations shared by the REST API (app.ts) and the MCP server
 * (mcp/server.ts).
 *
 * BrowserManager owns the browser lifecycle but not the composition around it:
 * deleting a profile also has to stop it, drop its row, its user-data dir and
 * its cached thumbnail, and launching has to classify user error (bad proxy,
 * missing seed) apart from server error. That composition used to live inline in
 * the Hono handlers; it lives here so the two front ends cannot drift.
 *
 * Nothing in this module imports Hono — callers map the results to their own
 * transport's error shape.
 */

import { rmSync } from 'node:fs';

import * as db from './db.js';
import { probeCdp } from './proxy/cdp.js';
import { deleteCachedThumb } from './screenshot.js';
import type { BrowserManager, RunningProfile } from './browser.js';
import type { ProfileCreate, ProfileResponse, ProfileRow } from './schemas.js';

/** Merge live runtime status onto a stored profile row. */
export function withStatus(mgr: BrowserManager, profile: ProfileRow): ProfileResponse {
  const status = mgr.getStatus(profile.id);
  return {
    ...profile,
    status: status.status,
    vnc_ws_port: status.vnc_ws_port,
    cdp_url: status.cdp_url,
  } as ProfileResponse;
}

export function listProfilesWithStatus(mgr: BrowserManager): ProfileResponse[] {
  return db.listProfiles().map((p) => withStatus(mgr, p));
}

export function getProfileWithStatus(
  mgr: BrowserManager,
  id: string
): ProfileResponse | null {
  const profile = db.getProfile(id);
  return profile ? withStatus(mgr, profile) : null;
}

/** `tags` is stored separately from the column set, so it is split out here. */
export function createProfileFromInput(input: ProfileCreate): ProfileRow {
  const { tags, ...fields } = input;
  return db.createProfile({ ...fields, tags: tags ?? [] } as never);
}

/**
 * Stop the profile if running, then remove every trace of it.
 * Returns false when there is no such profile.
 */
export async function deleteProfileFully(
  mgr: BrowserManager,
  id: string
): Promise<boolean> {
  if (mgr.running.has(id)) await mgr.stop(id);

  const profile = db.getProfile(id);
  if (!profile) return false;

  // DB first — if this throws, the filesystem is left untouched.
  db.deleteProfile(id);
  rmSync(profile.user_data_dir, { recursive: true, force: true });
  deleteCachedThumb(id);

  return true;
}

/**
 * Proxy validation and seed assertions are user error, not server error. The
 * messages come from browser.ts (`validateProxy`, `buildFingerprintArgs`).
 */
const USER_ERROR =
  /Invalid proxy|missing hostname|missing port|not parseable|fingerprint_seed/;

const CDP_POLL_INTERVAL_MS = 250;

/**
 * Wait until Chromium's CDP endpoint answers.
 *
 * `mgr.launch()` resolves once Playwright has a BrowserContext, which is not
 * quite the same as the DevTools HTTP endpoint being ready to accept a fresh
 * `connectOverCDP`. An agent that reads the CDP URL out of a launch result and
 * connects immediately would otherwise need its own retry loop.
 */
export async function waitForCdpReady(
  cdpPort: number,
  timeoutMs = 15_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probeCdp(cdpPort)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, CDP_POLL_INTERVAL_MS));
  }
}

export type LaunchResult =
  | { ok: true; running: RunningProfile; cdpReady: boolean }
  | { ok: 'not_found' }
  | { ok: 'conflict' }
  | { ok: 'bad_request'; message: string }
  | { ok: 'error'; message: string };

export async function launchProfileById(
  mgr: BrowserManager,
  id: string,
  opts: { waitForCdp?: boolean; timeoutMs?: number } = {}
): Promise<LaunchResult> {
  const profile = db.getProfile(id);
  if (!profile) return { ok: 'not_found' };
  if (mgr.running.has(id)) return { ok: 'conflict' };

  let running: RunningProfile;
  try {
    running = await mgr.launch(profile);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (USER_ERROR.test(message)) return { ok: 'bad_request', message };
    return { ok: 'error', message };
  }

  const cdpReady = opts.waitForCdp
    ? await waitForCdpReady(running.cdpPort, opts.timeoutMs)
    : false;

  return { ok: true, running, cdpReady };
}

/**
 * Absolute CDP URL, i.e. one an out-of-process client can actually pass to
 * `chromium.connectOverCDP()`. The REST API deliberately returns the relative
 * path (the frontend is same-origin); MCP clients are not.
 */
export function absoluteCdpUrl(baseUrl: string, id: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/profiles/${id}/cdp`;
}
