/**
 * First-launch profile bootstrap: bookmarks and default search engine.
 * Ported from _init_profile_defaults() in backend/browser_manager.py.
 *
 * Files are only written when absent, so user edits survive relaunches.
 *
 * The Chromium and Camoufox bootstraps share nothing but that rule. Chromium
 * reads JSON out of `Default/`; Firefox reads `user.js` and keeps bookmarks in
 * places.sqlite, which is why the Camoufox side sets prefs only.
 */

import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { logger } from './logger.js';

const log = logger('browser');

interface BookmarkNode {
  type: 'url' | 'folder';
  id: string;
  name: string;
  date_added: string;
  url?: string;
  children?: BookmarkNode[];
  date_modified?: string;
}

const BOOKMARK_TREE: Array<[string, Array<[string, string]>]> = [
  ['Detection Tests', [
    ['Rebrowser Bot Detector', 'https://bot-detector.rebrowser.net/'],
    ['Incolumitas', 'https://bot.incolumitas.com/'],
    ['SannySort', 'https://bot.sannysoft.com/'],
    ['BrowserScan Bot', 'https://www.browserscan.net/bot-detection'],
    ['FingerprintJS Demo', 'https://demo.fingerprint.com/web-scraping'],
    ['Pixelscan', 'https://pixelscan.net/fingerprint-check'],
    ['CreepJS', 'https://abrahamjuliot.github.io/creepjs/'],
    ['fingerprint-scan', 'https://fingerprint-scan.com/'],
    ['DeviceInfo Bot', 'https://deviceandbrowserinfo.com/are_you_a_bot'],
  ]],
  ['Fingerprint', [
    ['BrowserLeaks Canvas', 'https://browserleaks.com/canvas'],
    ['BrowserLeaks WebGL', 'https://browserleaks.com/webgl'],
    ['BrowserLeaks Fonts', 'https://browserleaks.com/fonts'],
    ['BrowserLeaks JS', 'https://browserleaks.com/javascript'],
    ['FingerprintJS OSS', 'https://fingerprintjs.github.io/fingerprintjs/'],
    ['Audio FP', 'https://audiofingerprint.openwpm.com/'],
    ['DeviceInfo', 'https://deviceandbrowserinfo.com/info_device'],
  ]],
  ['Headers & TLS', [
    ['httpbin headers', 'https://httpbin.org/headers'],
    ['httpbin IP', 'https://httpbin.org/ip'],
    ['TLS Fingerprint', 'https://tls.browserleaks.com/'],
  ]],
  ['reCAPTCHA', [
    ['Google v3 Demo', 'https://recaptcha-demo.appspot.com/recaptcha-v3-request-scores.php'],
    ['2captcha v3', 'https://2captcha.com/demo/recaptcha-v3'],
    ['Turnstile', 'https://peet.ws/turnstile-test/non-interactive.html'],
  ]],
];

export function initProfileDefaults(userDataDir: string): void {
  const defaultDir = path.join(userDataDir, 'Default');
  mkdirSync(defaultDir, { recursive: true });

  // --- Bookmarks (first launch only) ---
  const bookmarksPath = path.join(defaultDir, 'Bookmarks');
  if (!existsSync(bookmarksPath)) {
    const ts = String(Date.now() * 1000); // Chrome timestamp format (microseconds)
    let nextId = 1;

    const bm = (name: string, url: string): BookmarkNode => ({
      type: 'url', id: String(++nextId), name, url, date_added: ts,
    });
    const folder = (name: string, children: BookmarkNode[]): BookmarkNode => ({
      type: 'folder', id: String(++nextId), name, children,
      date_added: ts, date_modified: ts,
    });

    const bookmarks = {
      checksum: '',
      roots: {
        bookmark_bar: {
          type: 'folder', id: '1', name: 'Bookmarks bar',
          date_added: ts, date_modified: ts,
          children: BOOKMARK_TREE.map(([folderName, items]) =>
            folder(folderName, items.map(([name, url]) => bm(name, url)))
          ),
        },
        other: { type: 'folder', id: '2', name: 'Other bookmarks', children: [] },
        synced: { type: 'folder', id: '3', name: 'Mobile bookmarks', children: [] },
      },
      version: 1,
    };

    writeFileSync(bookmarksPath, JSON.stringify(bookmarks, null, 2));
    log.info(`Created default bookmarks for ${path.basename(userDataDir)}`);
  }

  // --- DuckDuckGo as default search engine ---
  const prefsPath = path.join(defaultDir, 'Preferences');
  if (!existsSync(prefsPath)) {
    const prefs = {
      default_search_provider_data: {
        template_url_data: {
          keyword: 'duckduckgo.com',
          short_name: 'DuckDuckGo',
          url: 'https://duckduckgo.com/?q={searchTerms}',
          suggestions_url: 'https://duckduckgo.com/ac/?q={searchTerms}&type=list',
          favicon_url: 'https://duckduckgo.com/favicon.ico',
        },
      },
      default_search_provider: { enabled: true },
    };
    writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));
    log.info(`Set DuckDuckGo as default search for ${path.basename(userDataDir)}`);
  }
}

/**
 * Camoufox (Firefox) equivalent of the above.
 *
 * `user.js` is applied over prefs.js on every start, which is exactly what we
 * want for a default we are willing to re-assert — but it also means anything
 * written here overrides a user's later change in the UI. It is therefore kept
 * to the search default, and written once, on first launch only.
 *
 * Bookmarks are deliberately skipped: Firefox stores them in places.sqlite, and
 * seeding that would mean a sqlite dependency for a convenience. They can be
 * added through the BrowserContext after launch if they are ever wanted.
 */
export function initCamoufoxProfileDefaults(userDataDir: string): void {
  mkdirSync(userDataDir, { recursive: true });

  const userJsPath = path.join(userDataDir, 'user.js');
  if (existsSync(userJsPath)) return;

  const prefs: Array<[string, string | boolean | number]> = [
    // DuckDuckGo as the default search engine, matching the Chromium profiles.
    ['browser.urlbar.placeholderName', 'DuckDuckGo'],
    ['browser.search.defaultenginename', 'DuckDuckGo'],
    ['browser.search.order.1', 'DuckDuckGo'],
    // Skip the first-run and "what's new" tabs — they would be the first thing
    // in the VNC view and they phone home to Mozilla on a profile whose whole
    // point is not to.
    ['browser.startup.homepage_override.mstone', 'ignore'],
    ['startup.homepage_welcome_url', ''],
    ['startup.homepage_welcome_url.additional', ''],
    ['browser.aboutwelcome.enabled', false],
    ['datareporting.policy.dataSubmissionEnabled', false],
    ['datareporting.healthreport.uploadEnabled', false],
    ['browser.shell.checkDefaultBrowser', false],
  ];

  const body = prefs
    .map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`)
    .join('\n');

  writeFileSync(userJsPath, `${body}\n`);
  log.info(`Created Camoufox profile defaults for ${path.basename(userDataDir)}`);
}
