/**
 * Guards for the Camoufox driver.
 *
 * The important one is `playwright-core still supports _userDataDir`. The
 * Camoufox driver depends on two undocumented launchServer options, and if a
 * playwright-core bump drops them the failure is silent and severe: launchServer
 * falls back to `launch()`, every Camoufox profile quietly becomes a throwaway
 * one, and users lose the logins the product exists to keep. A static assertion
 * against the installed bundle catches that on the version bump instead.
 */

import { readFileSync } from 'node:fs';
import { mkdtempSync, readFileSync as read, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import { toPlaywrightProxy, wsPathFor } from '../src/engines/camoufox.js';
import { driverFor, DRIVERS } from '../src/engines/index.js';
import { camoufoxConfigSchema, parseEngineConfig } from '../src/schemas.js';
import { initCamoufoxProfileDefaults } from '../src/profile-defaults.js';

const require = createRequire(import.meta.url);

function playwrightBundle(): string {
  const pkg = require.resolve('playwright-core/package.json');
  return readFileSync(path.join(path.dirname(pkg), 'lib', 'coreBundle.js'), 'utf8');
}

describe('playwright-core internals the Camoufox driver relies on', () => {
  const bundle = playwrightBundle();

  /**
   * Assert against a regex, not `toContain`. The bundle is ~3 MB, so a failed
   * substring assertion dumps the whole thing as a diff and tells you nothing;
   * and the minifier renames locals between releases (`options` in 1.62,
   * `options2` in 1.60), so the patterns must tolerate that suffix.
   */
  const has = (re: RegExp, what: string) => {
    if (!re.test(bundle)) {
      throw new Error(
        `playwright-core no longer contains ${what} (looked for ${re}). ` +
          `The Camoufox driver depends on it — re-verify src/engines/camoufox.ts ` +
          `against this version before shipping.`
      );
    }
  };

  it('still routes launchServer through launchPersistentContext for _userDataDir', () => {
    // Without this branch _userDataDir is ignored, launchServer falls back to
    // launch(), and every Camoufox profile silently becomes a throwaway one.
    has(/options\d*\._userDataDir !== void 0/, 'the launchServer _userDataDir branch');
    has(/launchPersistentContext\(progress\d*/, 'a server-side launchPersistentContext call');
  });

  it('still exposes the shared-browser mode', () => {
    // Without _sharedBrowser the dispatcher isolates contexts, so a connecting
    // client cannot see the persistent context and gets a blank browser.
    has(/_sharedBrowser/, 'the _sharedBrowser launchServer option');
    has(/launchServerShared/, "the 'launchServerShared' server mode");
    has(/isolateContexts: !options\d*\.sharedBrowser/, 'the sharedBrowser -> isolateContexts link');
  });

  it('still refuses to kill a pre-launched browser on client close', () => {
    // This is what stops a disconnecting automation client from ending the
    // session the VNC view is showing.
    has(/ignoreStopAndKill: true/, 'ignoreStopAndKill on the pre-launched browser dispatcher');
  });

  it('is a version this driver has actually been checked against', () => {
    const { version } = require('playwright-core/package.json') as { version: string };
    const [major, minor] = version.split('.').map(Number);
    // camoufox-js peer-requires <1.61.0. If this fails, re-verify the three
    // assertions above by hand before widening the range.
    expect(major).toBe(1);
    expect(minor).toBeLessThan(61);
  });
});

describe('camoufox version reporting', () => {
  it('joins version.json\'s split version and release', async () => {
    // version.json is {"version":"152.0.4","release":"beta.29"} but the release
    // tag is v152.0.4-beta.29. Reporting only the first half made a current
    // install permanently claim an update was available.
    const dir = mkdtempSync(path.join(tmpdir(), 'camoufox-ver-'));
    require('node:fs').writeFileSync(
      path.join(dir, 'version.json'),
      JSON.stringify({ version: '152.0.4', release: 'beta.29' })
    );
    const prev = process.env.CAMOUFOX_INSTALL_DIR;
    process.env.CAMOUFOX_INSTALL_DIR = dir;
    try {
      const { getCamoufoxBinaryStatus, resetCamoufoxLatestCache } = await import(
        '../src/camoufox-binary.js'
      );
      resetCamoufoxLatestCache();
      const status = await getCamoufoxBinaryStatus();
      expect(status.version).toBe('152.0.4-beta.29');
      // No binary in this temp dir, so it must not claim to be installed.
      expect(status.installed).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CAMOUFOX_INSTALL_DIR;
      else process.env.CAMOUFOX_INSTALL_DIR = prev;
    }
  });

  it('orders beta releases numerically, not lexically', async () => {
    const { versionNewer } = await import('../src/camoufox-binary.js');
    // A string compare puts beta.9 after beta.29, which would hide updates.
    expect(versionNewer('152.0.4-beta.29', '152.0.4-beta.9')).toBe(true);
    expect(versionNewer('152.0.4-beta.29', '152.0.4-beta.29')).toBe(false);
    expect(versionNewer('152.0.4-beta.9', '152.0.4-beta.29')).toBe(false);
  });
});

describe('driver registry', () => {
  it('dispatches each engine to its own driver', () => {
    expect(driverFor('chromium').engine).toBe('chromium');
    expect(driverFor('camoufox').engine).toBe('camoufox');
    expect(Object.keys(DRIVERS).sort()).toEqual(['camoufox', 'chromium']);
  });

  it('falls back to chromium for an unknown engine', () => {
    // A row written by a newer version must stay launchable, not throw.
    expect(driverFor('quantumfox').engine).toBe('chromium');
  });
});

describe('toPlaywrightProxy', () => {
  it('lifts credentials out of the authority', () => {
    // Firefox treats an inline-credential URL's whole authority as the host, so
    // leaving them in place is a connection failure, not an auth prompt.
    expect(toPlaywrightProxy('http://user:pass@host.example:8080')).toEqual({
      server: 'http://host.example:8080',
      username: 'user',
      password: 'pass',
    });
  });

  it('keeps a credential-less proxy credential-less', () => {
    expect(toPlaywrightProxy('socks5://10.0.0.1:1080')).toEqual({
      server: 'socks5://10.0.0.1:1080',
    });
  });

  it('preserves a default port that URL.port drops', () => {
    // URL.port is '' for http on :80, which previously rejected every proxy
    // running there — see extractPort() in proxy-config.ts.
    expect(toPlaywrightProxy('http://host.example:80').server).toBe('http://host.example:80');
  });

  it('percent-decodes credentials', () => {
    const p = toPlaywrightProxy('http://user%40corp:p%3Ass@host.example:8080');
    expect(p.username).toBe('user@corp');
    expect(p.password).toBe('p:ss');
  });
});

describe('wsPathFor', () => {
  it('namespaces the endpoint per profile', () => {
    expect(wsPathFor('abc-123')).toBe('/pw/abc-123');
  });
});

describe('camoufoxConfigSchema', () => {
  it('fills defaults for an empty config', () => {
    const cfg = camoufoxConfigSchema.parse({});
    expect(cfg.humanize).toBe(false);
    expect(cfg.geoip).toBe(false);
    expect(cfg.fingerprint_preset).toBe(true);
    expect(cfg.fonts).toEqual([]);
    expect(cfg.config).toEqual({});
  });

  it('accepts humanize as a duration and geoip as an IP', () => {
    const cfg = camoufoxConfigSchema.parse({ humanize: 1.5, geoip: '1.2.3.4' });
    expect(cfg.humanize).toBe(1.5);
    expect(cfg.geoip).toBe('1.2.3.4');
  });

  it('carries raw CAMOU_CONFIG overrides through untouched', () => {
    const cfg = camoufoxConfigSchema.parse({ config: { 'webrtc:ipv4': '9.9.9.9' } });
    expect(cfg.config).toEqual({ 'webrtc:ipv4': '9.9.9.9' });
  });

  it('rejects an unknown os rather than silently spoofing the wrong one', () => {
    expect(() => camoufoxConfigSchema.parse({ os: 'solaris' })).toThrow();
  });
});

describe('parseEngineConfig', () => {
  it('applies the camoufox schema for camoufox rows', () => {
    expect(parseEngineConfig('camoufox', {})).toMatchObject({ fingerprint_preset: true });
  });

  it('does not apply camoufox defaults to a chromium row', () => {
    // Chromium keeps its settings in the flat columns; leaking Camoufox
    // defaults into its config would be config bleed between engines.
    expect(parseEngineConfig('chromium', {})).toEqual({});
  });
});

describe('initCamoufoxProfileDefaults', () => {
  it('writes a user.js with the search default', () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'camoufox-def-')), 'profile');
    initCamoufoxProfileDefaults(dir);
    const userJs = read(path.join(dir, 'user.js'), 'utf8');
    expect(userJs).toContain('user_pref("browser.search.defaultenginename", "DuckDuckGo");');
    expect(userJs).toContain('datareporting.healthreport.uploadEnabled');
  });

  it('does not clobber a user.js the profile already has', () => {
    // user.js is re-applied over prefs.js on every start, so rewriting it would
    // silently revert whatever the user changed in the browser.
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'camoufox-def-')), 'profile');
    initCamoufoxProfileDefaults(dir);
    const file = path.join(dir, 'user.js');
    require('node:fs').writeFileSync(file, 'user_pref("mine", true);\n');
    initCamoufoxProfileDefaults(dir);
    expect(read(file, 'utf8')).toBe('user_pref("mine", true);\n');
  });

  it('writes no Chrome-format files', () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'camoufox-def-')), 'profile');
    initCamoufoxProfileDefaults(dir);
    expect(existsSync(path.join(dir, 'Default'))).toBe(false);
  });
});
