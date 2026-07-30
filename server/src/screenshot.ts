/**
 * Per-profile screenshots, with a last-seen cache on disk.
 *
 * A running profile is captured live through the Playwright context the manager
 * already holds — no extra CDP plumbing. The bytes are also written to
 * <dataDir>/thumbs/<id>.jpg so a *stopped* profile still has something to show,
 * which is what makes the sidebar thumbnails useful rather than mostly blank.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { getDataDir } from './db.js';
import { logger } from './logger.js';
import type { RunningProfile } from './browser.js';

const log = logger('screenshot');

// JPEG at moderate quality: a thumbnail strip should not cost more than the page
// it decorates. PNG screenshots of a 1920x1080 desktop run into megabytes.
const JPEG_QUALITY = 55;

// Capturing must never block a request indefinitely — a wedged browser will
// simply never answer.
const CAPTURE_TIMEOUT_MS = 5000;

export interface Screenshot {
  bytes: Buffer;
  /** true when read from disk rather than captured just now. */
  cached: boolean;
}

function thumbsDir(): string {
  return path.join(getDataDir(), 'thumbs');
}

export function thumbPath(profileId: string): string {
  return path.join(thumbsDir(), `${profileId}.jpg`);
}

function readCached(profileId: string): Buffer | null {
  try {
    return readFileSync(thumbPath(profileId));
  } catch {
    return null;
  }
}

function writeCached(profileId: string, bytes: Buffer): void {
  try {
    mkdirSync(thumbsDir(), { recursive: true });
    writeFileSync(thumbPath(profileId), bytes);
  } catch (err) {
    // A failed cache write must not fail the request — the caller already has
    // perfectly good bytes in hand.
    log.debug(`Could not cache thumbnail for ${profileId}: ${String(err)}`);
  }
}

/** Drop the cached thumbnail. Called when a profile is deleted. */
export function deleteCachedThumb(profileId: string): void {
  rmSync(thumbPath(profileId), { force: true });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Screenshot timed out after ${ms}ms`)), ms)
    ),
  ]);
}

/**
 * Capture the profile's first open page. Returns null when there is nothing to
 * capture (no pages, context already closed) so the caller can fall back to cache.
 */
async function capture(running: RunningProfile): Promise<Buffer | null> {
  const pages = running.context.pages();
  const page = pages.find((p) => !p.isClosed());
  if (!page) return null;

  const bytes = await withTimeout(
    page.screenshot({ type: 'jpeg', quality: JPEG_QUALITY }),
    CAPTURE_TIMEOUT_MS
  );
  return Buffer.from(bytes);
}

/**
 * Live capture when running, cached bytes otherwise. Returns null only when the
 * profile has never been captured successfully.
 */
export async function getScreenshot(
  profileId: string,
  running: RunningProfile | undefined
): Promise<Screenshot | null> {
  if (running) {
    try {
      const bytes = await capture(running);
      if (bytes) {
        writeCached(profileId, bytes);
        return { bytes, cached: false };
      }
    } catch (err) {
      // A closed context, a navigating page, or a wedged browser all land here.
      // The cached image is the better answer than a 500.
      log.debug(`Live capture failed for ${profileId}: ${String(err)}`);
    }
  }

  const cached = readCached(profileId);
  return cached ? { bytes: cached, cached: true } : null;
}
