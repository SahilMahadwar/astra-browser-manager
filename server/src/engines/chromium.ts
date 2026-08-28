/**
 * CloakBrowser (stealth Chromium) driver.
 *
 * This is the original launch path, lifted out of BrowserManager unchanged. The
 * fingerprint flags, the Singleton* lock cleanup and the Chrome-format profile
 * bootstrap are all Chromium-specific and stay here rather than leaking into
 * the shared manager.
 */

import { rmSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext } from 'playwright-core';

import { CLIPBOARD_INIT_JS, describeProxy, normalizeProxy, validateProxy } from '../proxy-config.js';
import { initProfileDefaults } from '../profile-defaults.js';
import { logger } from '../logger.js';
import type { ProfileRow } from '../schemas.js';
import type { EngineDriver, EngineSession, LaunchContext } from './types.js';

const log = logger('browser');

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

export const chromiumDriver: EngineDriver = {
  engine: 'chromium',

  validate(profile: ProfileRow): void {
    buildFingerprintArgs(profile); // asserts fingerprint_seed
    if (profile.proxy) validateProxy(normalizeProxy(profile.proxy));
  },

  async launch(profile: ProfileRow, ctx: LaunchContext): Promise<EngineSession> {
    const { display, userDataDir, port } = ctx;

    // Clear Chromium lock files left by a previous crash.
    for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      rmSync(path.join(userDataDir, lock), { force: true });
    }

    initProfileDefaults(userDataDir);

    const args = [
      ...buildFingerprintArgs(profile),
      ...(profile.launch_args ?? []),
      `--remote-debugging-port=${port}`,
    ];

    const rawProxy = profile.proxy || null;
    const proxy = rawProxy ? normalizeProxy(rawProxy) : undefined;
    if (proxy) {
      validateProxy(proxy);
      log.debug(`Profile ${profile.id} proxy: ${describeProxy(proxy)}`);
    }

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

    return {
      context,
      automation: { protocol: 'cdp', port, url: `http://127.0.0.1:${port}` },
      onClose: (cb) => context.on('close', cb),
      close: () => context.close(),
    };
  },
};
