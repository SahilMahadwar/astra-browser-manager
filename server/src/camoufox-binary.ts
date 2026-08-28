/**
 * Which Camoufox build is installed, and whether a newer one exists.
 *
 * The sibling of binary.ts, which does the same for CloakBrowser's Chromium.
 * They are separate on purpose: the two engines have different release naming,
 * different platform tags and different install layouts, and folding them into
 * one module would mean a change for one engine could break reporting for the
 * other.
 *
 * Unlike binary.ts this module does not trigger downloads. The Camoufox archive
 * is ~630 MB and is baked into the image at build time (`npx camoufox-js
 * fetch`); pulling that at runtime into a container's writable layer is not
 * something to kick off from an HTTP request.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { logger } from './logger.js';

const log = logger('binary');

const GITHUB_RELEASES_URL =
  'https://api.github.com/repos/daijro/camoufox/releases?per_page=10';
const FETCH_TIMEOUT_MS = 10_000;
/** Matches binary.ts's cadence. The API rate-limits anonymous requests. */
const LATEST_CACHE_MS = 60 * 60 * 1000;

export interface CamoufoxBinaryStatus {
  /** Version string from the install dir's version.json, if readable. */
  version: string | null;
  installed: boolean;
  platform: string;
  install_dir: string;
  binary_path: string | null;
  latest_version: string | null;
  update_available: boolean;
}

interface GithubAsset {
  name: string;
}
interface GithubRelease {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GithubAsset[];
}

/** Camoufox's own OS/arch tokens, which are not Node's. */
export function platformTag(): string {
  const os = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'lin';
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'i686' : 'x86_64';
  return `${os}.${arch}`;
}

/** Executable name per platform. On Linux it is `camoufox-bin`, not `camoufox`. */
export function launchFileFor(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'camoufox.exe';
  if (platform === 'darwin') return path.join('..', 'MacOS', 'camoufox');
  return 'camoufox-bin';
}

/**
 * Where camoufox-js looks for the binary: CAMOUFOX_INSTALL_DIR, else the
 * platform user cache dir. The Docker image sets the env var explicitly so the
 * binary lands somewhere predictable rather than in root's cache.
 */
export function installDir(): string {
  if (process.env.CAMOUFOX_INSTALL_DIR) return path.resolve(process.env.CAMOUFOX_INSTALL_DIR);
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'camoufox', 'Cache');
  }
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Caches', 'camoufox');
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache'), 'camoufox');
}

/**
 * Pick the newest release carrying an archive for this platform.
 *
 * Camoufox ships only beta tags right now, so unlike the Chromium side we must
 * NOT filter prereleases out — doing so would report "no releases" forever.
 * Drafts are still skipped, and so is any release with no asset for us.
 */
export function pickLatestVersion(
  releases: GithubRelease[],
  platform: string
): string | null {
  const suffix = `-${platform}.zip`;
  for (const release of releases) {
    if (release.draft) continue;
    const tag = release.tag_name ?? '';
    if (!tag.startsWith('v')) continue;
    if (!(release.assets ?? []).some((a) => a.name.endsWith(suffix))) continue;
    return tag.replace(/^v/, '');
  }
  return null;
}

let latestCache: { version: string | null; at: number } | null = null;

/** Never throws: an unreachable or rate-limited GitHub must read as "unknown". */
export async function fetchLatestVersion(
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
      version = pickLatestVersion((await res.json()) as GithubRelease[], platform);
    } else {
      log.debug(`Camoufox release check returned HTTP ${res.status}`);
    }
  } catch (err) {
    log.debug(`Camoufox release check failed: ${String(err)}`);
  }
  latestCache = { version, at: Date.now() };
  return version;
}

/** @internal Test seam — the cache is process-wide and would leak between cases. */
export function resetCamoufoxLatestCache(): void {
  latestCache = null;
}

/**
 * Compare two Camoufox versions, e.g. `152.0.4-beta.29`.
 *
 * The beta suffix is significant: `152.0.4-beta.29` is newer than
 * `152.0.4-beta.9`, which a plain string compare gets backwards.
 */
export function versionNewer(a: string, b: string): boolean {
  const parts = (v: string) => (v.match(/\d+/g) ?? []).map(Number);
  const va = parts(a);
  const vb = parts(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const x = va[i] ?? 0;
    const y = vb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

/** Never throws — the dashboard polls this and a bad install must not 500. */
export async function getCamoufoxBinaryStatus(): Promise<CamoufoxBinaryStatus> {
  const dir = installDir();
  const binaryPath = path.join(dir, launchFileFor());
  const installed = existsSync(binaryPath);

  let version: string | null = null;
  try {
    const raw = readFileSync(path.join(dir, 'version.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string; release?: string };
    // version.json splits the release: {"version":"152.0.4","release":"beta.29"}.
    // Both halves are needed — reporting just "152.0.4" against a "152.0.4-beta.29"
    // release tag makes an up-to-date install look permanently outdated.
    version = parsed.version
      ? parsed.release
        ? `${parsed.version}-${parsed.release}`
        : parsed.version
      : (parsed.release ?? null);
  } catch {
    // Not installed, or an install that predates version.json.
  }

  const platform = platformTag();
  const latest = await fetchLatestVersion(platform);

  return {
    version,
    installed,
    platform,
    install_dir: dir,
    binary_path: installed ? binaryPath : null,
    latest_version: latest,
    update_available: Boolean(latest && version && versionNewer(latest, version)),
  };
}
