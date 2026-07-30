/**
 * Which CloakBrowser Chromium binary is installed, whether a newer one exists,
 * and updating to it.
 *
 * `/api/status` reports `CHROMIUM_VERSION` — the version the *wrapper* was
 * built against, not the one on disk. That distinction is not cosmetic: the
 * resolved binary version decides whether a credentialed HTTP proxy gets
 * Chrome's inline `--proxy-server=http://user:pass@host:port` auth or falls back
 * to Playwright's CDP auth interceptor, which upstream documents as broken on
 * some proxies. A profile that suddenly prompts for proxy credentials is
 * diagnosable only if the running version is visible.
 *
 * Downloading, signature verification and the cloakbrowser.dev → GitHub fallback
 * all belong to cloakbrowser's own `checkForUpdate()`; this module only reports
 * and triggers. The one thing it reimplements is the "what is the newest
 * release?" lookup, because cloakbrowser's `getLatestChromiumVersion()` is
 * internal.
 */

import { existsSync } from 'node:fs';

import { logger } from './logger.js';

const log = logger('binary');

const GITHUB_RELEASES_URL =
  'https://api.github.com/repos/CloakHQ/cloakbrowser/releases?per_page=10';
const FETCH_TIMEOUT_MS = 10_000;
/** Matches cloakbrowser's own hourly cadence. The API rate-limits anonymously. */
const LATEST_CACHE_MS = 60 * 60 * 1000;

export type UpdateState = 'idle' | 'running' | 'done' | 'error';

export interface BinaryStatus {
  /** The version that will actually launch, or null if none resolves. */
  version: string | null;
  /** The version the installed wrapper was built against. */
  bundled_version: string;
  tier: 'free' | 'pro' | 'override';
  installed: boolean;
  platform: string;
  binary_path: string | null;
  /** Newest published release carrying a binary for this platform, if known. */
  latest_version: string | null;
  update_available: boolean;
  /**
   * Whether this install is one we can update from GitHub. False for Pro (its
   * builds come from cloakbrowser.dev behind a licence) and for a local
   * `CLOAKBROWSER_BINARY_PATH` override, which is the operator's own binary.
   */
  updatable: boolean;
  update: {
    state: UpdateState;
    /** Version installed by the last successful update, if any. */
    version: string | null;
    error: string | null;
  };
}

interface GithubAsset {
  name: string;
}

interface GithubRelease {
  tag_name: string;
  draft?: boolean;
  assets?: GithubAsset[];
}

/** Numeric compare over dot-separated versions. True when `a` is newer than `b`. */
export function versionNewer(a: string, b: string): boolean {
  const va = a.split('.').map(Number);
  const vb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const x = va[i] ?? 0;
    const y = vb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

/** The release asset that carries the browser for a platform tag. */
export function archiveNameFor(platform: string): string {
  return platform.startsWith('windows')
    ? `cloakbrowser-${platform}.zip`
    : `cloakbrowser-${platform}.tar.gz`;
}

/**
 * Newest `chromium-v*` release that actually ships a binary for this platform.
 *
 * Pro builds are published as `chromium-v<version>-pro` and carry only
 * `SHA256SUMS.sig` — no archive. They are dropped twice over: by the tag suffix
 * and by the asset requirement. Picking one up would report an "update" that
 * can never be downloaded. Mirrors `getLatestChromiumVersion()` in
 * cloakbrowser's `dist/download.js`.
 */
export function pickLatestFreeVersion(
  releases: GithubRelease[],
  platform: string
): string | null {
  const archive = archiveNameFor(platform);
  for (const release of releases) {
    const tag = release.tag_name ?? '';
    if (!tag.startsWith('chromium-v') || tag.endsWith('-pro')) continue;
    if (release.draft) continue;
    if (!(release.assets ?? []).some((a) => a.name === archive)) continue;
    return tag.replace(/^chromium-v/, '');
  }
  return null;
}

let latestCache: { version: string | null; at: number } | null = null;

/**
 * Never throws: an unreachable or rate-limited GitHub (403 is routine for
 * anonymous requests) must show as "could not check", not as a failed page.
 */
export async function fetchLatestFreeVersion(
  platform: string,
  force = false
): Promise<string | null> {
  if (!force && latestCache && Date.now() - latestCache.at < LATEST_CACHE_MS) {
    return latestCache.version;
  }
  let version: string | null = null;
  try {
    const res = await fetch(GITHUB_RELEASES_URL, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      version = pickLatestFreeVersion((await res.json()) as GithubRelease[], platform);
    } else {
      log.debug(`GitHub release check returned HTTP ${res.status}`);
    }
  } catch (err) {
    log.debug(`GitHub release check failed: ${String(err)}`);
  }
  // Cache misses too, so a rate-limited API is not hammered once per poll.
  latestCache = { version, at: Date.now() };
  return version;
}

/** @internal Test seam — the cache is process-wide and would leak between cases. */
export function resetLatestCache(): void {
  latestCache = null;
}

let update: BinaryStatus['update'] = { state: 'idle', version: null, error: null };
let running: Promise<void> | null = null;

export function getUpdateState(): BinaryStatus['update'] {
  return { ...update };
}

/**
 * Kick off a download if one is not already in flight. Returns immediately: the
 * archive is ~70 MB, far too slow to hold a request open, so the UI polls
 * `GET /api/binary` for the outcome.
 */
export function startUpdate(): BinaryStatus['update'] {
  if (running) return getUpdateState();

  update = { state: 'running', version: update.version, error: null };
  running = (async () => {
    try {
      const { checkForUpdate } = await import('cloakbrowser');
      const version = await checkForUpdate();
      if (version) {
        log.info(`Updated Chromium binary to ${version}; takes effect on next launch`);
        update = { state: 'done', version, error: null };
      } else {
        log.info('Chromium binary already up to date');
        update = { state: 'done', version: null, error: null };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Chromium binary update failed: ${message}`);
      update = { state: 'error', version: null, error: message };
    } finally {
      running = null;
    }
  })();

  return getUpdateState();
}

/** @internal Test seam. */
export function resetUpdateState(): void {
  update = { state: 'idle', version: null, error: null };
}

/**
 * Never throws — the dashboard renders this on every poll, and a cloakbrowser
 * import failure must not take the endpoint down with it.
 */
export async function getBinaryStatus(): Promise<BinaryStatus> {
  const override = process.env.CLOAKBROWSER_BINARY_PATH || null;

  let version: string | null = null;
  let bundled = 'unknown';
  let tier: BinaryStatus['tier'] = 'free';
  let platform = process.platform === 'win32' ? 'windows-x64' : 'linux-x64';
  let binaryPath: string | null = override;
  let installed = false;

  try {
    const { binaryInfo } = await import('cloakbrowser');
    const info = binaryInfo();
    bundled = info.bundledVersion;
    platform = info.platform;
    // binaryInfo() describes the managed cache and does not account for an
    // override, so under one its version and installed flag describe a binary
    // that will never launch. The override's version is unknowable — it is
    // whatever the operator mounted.
    if (override) {
      installed = existsSync(override);
    } else {
      version = info.version;
      tier = info.tier;
      binaryPath = info.binaryPath;
      installed = info.installed;
    }
  } catch (err) {
    log.debug(`Could not read binary info: ${String(err)}`);
  }

  // Pro builds are licensed downloads from cloakbrowser.dev and an override is
  // the operator's own binary; neither is ours to replace from GitHub.
  const updatable = tier === 'free' && !override;
  const latest = updatable ? await fetchLatestFreeVersion(platform) : null;

  return {
    version,
    bundled_version: bundled,
    tier: override ? 'override' : tier,
    installed,
    platform,
    binary_path: binaryPath,
    latest_version: latest,
    update_available: Boolean(latest && version && versionNewer(latest, version)),
    updatable,
    update: getUpdateState(),
  };
}
