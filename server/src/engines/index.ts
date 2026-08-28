/**
 * Engine registry. Adding a browser means adding a driver here and an entry to
 * ENGINES in schemas.ts — nothing in the manager, the routes or the proxies
 * should need to know the difference.
 */

import { camoufoxDriver } from './camoufox.js';
import { chromiumDriver } from './chromium.js';
import type { Engine } from '../schemas.js';
import type { EngineDriver } from './types.js';

export const DRIVERS: Record<Engine, EngineDriver> = {
  chromium: chromiumDriver,
  camoufox: camoufoxDriver,
};

/**
 * Unknown engines fall back to Chromium rather than throwing: a row written by
 * a newer version must still be launchable, and Chromium is what every
 * pre-multi-engine row is.
 */
export function driverFor(engine: string): EngineDriver {
  return DRIVERS[engine as Engine] ?? DRIVERS.chromium;
}

export { chromiumDriver, camoufoxDriver };
export * from './types.js';
