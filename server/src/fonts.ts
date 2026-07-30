/**
 * Windows font-set completeness check.
 *
 * On Linux the binary spoofs the Windows platform, but fonts come from the host
 * OS. A container enumerating only Liberation + msttcorefonts contradicts the
 * Windows claim, and font-fingerprinting anti-bot systems flag the mismatch
 * (CloakHQ/CloakBrowser#395). The image ships no Microsoft-proprietary fonts —
 * operators supply their own via /data/fonts, registered by entrypoint.sh — so
 * we report at startup whether that set is actually complete.
 *
 * cloakbrowser has this same list in its own dist/fonts.js and warns once per
 * environment, but that module is not re-exported from its index and its
 * package.json `exports` map has no deep-import path, so the list below is a
 * deliberate copy rather than an import. Re-check it on every version bump.
 */

import { execFileSync } from 'node:child_process';

import { logger } from './logger.js';

const log = logger('browser');

/**
 * Windows OS fonts — these ship with Windows itself, so their absence on a
 * Windows-spoofing Linux host degrades the persona. The two monospace entries
 * (Consolas + Courier New) are included so the generic `monospace` family
 * resolves to a Windows font.
 *
 * Treated as all-or-nothing: a real Windows font install is atomic, so a
 * partial set is its own tell. Verbatim from cloakbrowser 0.5.2's
 * WINDOWS_FONT_TELLS.
 */
export const WINDOWS_FONT_TELLS = [
  'Segoe UI',
  'Segoe UI Light',
  'Calibri',
  'Marlett',
  'MS UI Gothic',
  'Franklin Gothic',
  'Consolas',
  'Courier New',
] as const;

/**
 * Names from WINDOWS_FONT_TELLS that fontconfig cannot find.
 *
 * Returns `null` when the answer is unknowable (no `fc-list`, or it errored).
 * Callers must not conflate `null` with `[]` — the latter means the set is
 * genuinely complete.
 */
export function missingWindowsFonts(): string[] | null {
  let listing: string;
  try {
    // maxBuffer 16 MB: a host with a large font set produces an fc-list listing
    // well over Node's 1 MB default, which would otherwise throw here and turn
    // a complete install into an "unknown".
    listing = execFileSync('fc-list', {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
    }).toLowerCase();
  } catch {
    return null;
  }
  return WINDOWS_FONT_TELLS.filter((f) => !listing.includes(f.toLowerCase()));
}

/**
 * Log the Windows font-set status once at startup. Best-effort: silent when
 * undeterminable, and never throws.
 */
export function logFontStatus(): void {
  try {
    const missing = missingWindowsFonts();
    if (missing === null) return;

    if (missing.length === 0) {
      log.info('Windows font set complete — --fingerprint-windows-font-metrics will apply.');
      return;
    }

    log.warn(
      `Incomplete Windows font set — missing: ${missing.join(', ')}. ` +
        `Windows-platform profiles will enumerate Linux fonts. Copy the ` +
        `missing files from a licensed Windows machine into /data/fonts and ` +
        `restart.`
    );
  } catch {
    // Diagnostics must never take the server down.
  }
}
