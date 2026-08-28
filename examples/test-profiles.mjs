#!/usr/bin/env node
/**
 * End-to-end test for both browser engines.
 *
 *   node test-profiles.mjs                     # both engines
 *   node test-profiles.mjs --engine=camoufox   # one engine
 *   node test-profiles.mjs --keep              # leave the profiles behind
 *
 * Env:
 *   BASE_URL         default http://localhost:8080
 *   AUTH_TOKEN       required if the server sets one
 *   OPENAI_API_KEY   optional — enables the Stagehand (AI) leg on Chromium
 *
 * ---------------------------------------------------------------------------
 * Why this is not purely a Stagehand script
 *
 * Stagehand is Chromium-only, in every version. From its own docs:
 * "Chromium only. Stagehand has no Firefox or WebKit support." It attaches over
 * CDP, and Camoufox is Firefox 152 — Firefox deleted its CDP implementation in
 * 141, so there is no endpoint for Stagehand to attach to. This is not a gap in
 * this server; nothing can drive Camoufox over CDP.
 *
 * So each engine is exercised with the client that can actually drive it:
 *   chromium -> Stagehand (AI act/extract) over CDP
 *   camoufox -> Playwright firefox.connect() over the Playwright protocol
 *
 * Both legs then run the identical stealth and persistence assertions, which is
 * the point: the engines differ in transport and in nothing else that matters.
 * ---------------------------------------------------------------------------
 */

import { firefox } from 'playwright-core';

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const AUTH_TOKEN = process.env.AUTH_TOKEN ?? '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
/** Must be one of Stagehand's allowlisted provider/model strings. */
const MODEL_NAME = process.env.STAGEHAND_MODEL ?? 'openai/gpt-4.1-mini';

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith('--engine='))?.split('=')[1];
const KEEP = args.includes('--keep');
const ENGINES = only ? [only] : ['chromium', 'camoufox'];

const authHeaders = AUTH_TOKEN ? { authorization: `Bearer ${AUTH_TOKEN}` } : {};
/**
 * Automation endpoints accept the token as a query parameter, and for Camoufox
 * that is the ONLY channel: playwright's firefox.connect() takes no headers
 * option at all.
 */
const tokenQuery = AUTH_TOKEN ? `?token=${encodeURIComponent(AUTH_TOKEN)}` : '';

let failures = 0;
const pass = (m) => console.log(`   \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { failures++; console.log(`   \x1b[31m✗ ${m}\x1b[0m`); };
const step = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);
const check = (cond, m, detail) => (cond ? pass(m) : fail(`${m}${detail ? ` — ${detail}` : ''}`));

async function api(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...authHeaders, ...(options.headers ?? {}) },
  });
  const body = await res.text();
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = body; }
  if (!res.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} -> ${res.status} ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The profile config each engine gets. Shared fields stay identical on purpose. */
function profileBody(engine) {
  const shared = {
    name: `E2E ${engine} ${Date.now()}`,
    proxy: process.env.TEST_PROXY || null,
    screen_width: 1280,
    screen_height: 800,
  };
  return engine === 'camoufox'
    ? { ...shared, engine, engine_config: { os: 'windows', humanize: true } }
    : { ...shared, engine, platform: 'windows' };
}

/**
 * The assertions worth making about any stealth profile, run identically for
 * both engines so a regression in one shows up against the other.
 */
async function assertStealth(evaluate, engine) {
  const fp = await evaluate(`({
    ua: navigator.userAgent,
    platform: navigator.platform,
    webdriver: navigator.webdriver,
    languages: navigator.languages.join(','),
    cores: navigator.hardwareConcurrency,
    screen: screen.width + 'x' + screen.height,
    outer: outerWidth + 'x' + outerHeight,
    plugins: navigator.plugins.length
  })`);

  console.log(`   ${JSON.stringify(fp)}`);

  // The single most-checked automation tell.
  check(fp.webdriver === false, 'navigator.webdriver is false', `got ${fp.webdriver}`);

  // A profile that claims Windows must claim it everywhere. A UA/platform split
  // is a stronger signal than either value alone.
  check(/Windows NT/.test(fp.ua), 'user agent claims Windows');
  check(fp.platform === 'Win32', 'navigator.platform agrees with the UA', `got ${fp.platform}`);

  const expectedEngine = engine === 'camoufox' ? /Firefox\// : /Chrome\//;
  check(expectedEngine.test(fp.ua), `user agent is ${engine === 'camoufox' ? 'Firefox' : 'Chrome'}-based`);

  // The window cannot be larger than the screen it is on.
  const [sw] = fp.screen.split('x').map(Number);
  const [ow] = fp.outer.split('x').map(Number);
  check(ow <= sw, 'window fits inside the reported screen', `${fp.outer} vs ${fp.screen}`);

  return fp;
}

// ── Chromium: Stagehand over CDP ────────────────────────────────────────────

async function runChromium(profile) {
  const cdpUrl = `${BASE_URL}${profile.cdp_url}${tokenQuery}`;
  console.log(`   cdp_url: ${cdpUrl.replace(tokenQuery, tokenQuery && '?token=***')}`);

  const { Stagehand } = await import('@browserbasehq/stagehand');

  const stagehand = new Stagehand({
    env: 'LOCAL',
    // A bare CDP URL string is Stagehand's only handoff for an existing browser,
    // with nowhere to hang an Authorization header — which is exactly why this
    // server accepts ?token= on the automation routes.
    localBrowserLaunchOptions: { cdpUrl },
    // 3.7.x takes model config as one object. The v2-era `modelName` +
    // `modelClientOptions` pair is silently ignored here, and the key then
    // falls back to the environment — which looks like "API key is missing"
    // even though you passed one.
    model: { modelName: MODEL_NAME, apiKey: OPENAI_API_KEY },
    verbose: 0,
  });

  await stagehand.init();
  try {
    // act/extract/observe live on the Stagehand instance in 3.7.x, and pages
    // come off its context — there is no stagehand.page in this line.
    const page = stagehand.context.pages()[0] ?? (await stagehand.context.newPage());
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    check((await page.title()) === 'Example Domain', 'Stagehand attached and navigated');

    const fp = await assertStealth((expr) => page.evaluate(expr), 'chromium');

    const { z } = await import('zod');
    const extracted = await stagehand.extract(
      'Extract the page heading and the first paragraph of body text',
      z.object({ heading: z.string(), body: z.string() })
    );
    check(/example domain/i.test(extracted.heading ?? ''),
      'Stagehand extract() read the page', JSON.stringify(extracted));

    const actResult = await stagehand.act('Click the "More information..." link');
    check(actResult?.success !== false, 'Stagehand act() reported success',
      JSON.stringify(actResult));
    await page.waitForLoadState('domcontentloaded');
    check(!/example\.com\/?$/.test(page.url()), 'act() actually navigated', `url=${page.url()}`);

    return fp;
  } finally {
    // Disconnects Stagehand. The profile keeps running — the server owns its
    // lifecycle, not the client.
    await stagehand.close();
  }
}

/** Same Chromium checks without an LLM, for when no model key is configured. */
async function runChromiumNoAI(profile) {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(`${BASE_URL}${profile.cdp_url}${tokenQuery}`);
  try {
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    check((await page.title()) === 'Example Domain', 'connectOverCDP navigated the profile');
    return await assertStealth((expr) => page.evaluate(expr), 'chromium');
  } finally {
    await browser.close();
  }
}

// ── Camoufox: Playwright protocol ───────────────────────────────────────────

async function runCamoufox(profile) {
  const wsUrl = `${BASE_URL.replace(/^http/, 'ws')}${profile.automation_url}${tokenQuery}`;
  console.log(`   automation_url: ${wsUrl.replace(tokenQuery, tokenQuery && '?token=***')}`);

  const browser = await firefox.connect(wsUrl);
  try {
    // contexts()[0] is the profile's persistent context — the same window the
    // live view shows. newContext() would create a throwaway one and lose the
    // profile's identity, which is the entire point of a profile.
    const ctx = browser.contexts()[0];
    check(Boolean(ctx), 'client sees the profile\'s persistent context');
    if (!ctx) return null;

    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    check((await page.title()) === 'Example Domain', 'firefox.connect() navigated the profile');

    return await assertStealth((expr) => page.evaluate(expr), 'camoufox');
  } finally {
    await browser.close();
  }
}

// ── Persistence ─────────────────────────────────────────────────────────────

/** Connect with whichever client the engine needs, and hand back a page. */
async function connectTo(profile) {
  if (profile.automation_protocol === 'playwright-firefox') {
    const browser = await firefox.connect(
      `${BASE_URL.replace(/^http/, 'ws')}${profile.automation_url}${tokenQuery}`
    );
    const ctx = browser.contexts()[0];
    return { browser, ctx, page: ctx.pages()[0] ?? (await ctx.newPage()) };
  }
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(`${BASE_URL}${profile.cdp_url}${tokenQuery}`);
  const ctx = browser.contexts()[0];
  return { browser, ctx, page: ctx.pages()[0] ?? (await ctx.newPage()) };
}

async function assertPersistence(id) {
  let profile = await api(`/api/profiles/${id}`);

  {
    const { browser, ctx, page } = await connectTo(profile);
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    // A session cookie is never written to disk, so an expiry is what makes
    // this a real test rather than a no-op.
    await ctx.addCookies([{
      name: 'persist_probe', value: 'kept', domain: 'example.com', path: '/',
      expires: Math.floor(Date.now() / 1000) + 86_400,
    }]);
    await page.evaluate("localStorage.setItem('persist_probe','kept')");
    await browser.close();
  }

  await api(`/api/profiles/${id}/stop`, { method: 'POST' });
  await sleep(3000);
  await api(`/api/profiles/${id}/launch`, { method: 'POST' });
  await sleep(4000);
  profile = await api(`/api/profiles/${id}`);

  {
    const { browser, ctx, page } = await connectTo(profile);
    const cookies = await ctx.cookies('http://example.com');
    check(cookies.some((c) => c.name === 'persist_probe'), 'cookies survived stop + relaunch',
      JSON.stringify(cookies.map((c) => c.name)));
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    const ls = await page.evaluate("localStorage.getItem('persist_probe')");
    check(ls === 'kept', 'localStorage survived stop + relaunch', `got ${ls}`);
    await browser.close();
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function testEngine(engine) {
  step(`═══ ${engine} ═══`);
  const created = await api('/api/profiles', {
    method: 'POST',
    body: JSON.stringify(profileBody(engine)),
  });
  console.log(`   profile ${created.id}`);

  try {
    const launched = await api(`/api/profiles/${created.id}/launch`, { method: 'POST' });
    check(launched.status === 'running', 'profile launched');
    check(launched.engine === engine, 'reports the right engine', launched.engine);

    // The contract an external client actually branches on.
    if (engine === 'camoufox') {
      check(launched.automation_protocol === 'playwright-firefox',
        'automation_protocol is playwright-firefox', launched.automation_protocol);
      check(launched.cdp_url === null,
        'cdp_url is null — Firefox has no CDP', String(launched.cdp_url));
    } else {
      check(launched.automation_protocol === 'cdp', 'automation_protocol is cdp');
      check(typeof launched.cdp_url === 'string',
        'cdp_url still populated — existing CDP clients unaffected');
    }

    // Launch returns before the endpoint is necessarily accepting connections.
    await sleep(3000);
    const profile = await api(`/api/profiles/${created.id}`);

    step(`→ driving ${engine}`);
    if (engine === 'camoufox') {
      await runCamoufox(profile);
    } else if (OPENAI_API_KEY) {
      await runChromium(profile);
    } else {
      console.log('   (no OPENAI_API_KEY — running the same checks without Stagehand)');
      await runChromiumNoAI(profile);
    }

    step(`→ ${engine} screenshot endpoint`);
    const shot = await fetch(`${BASE_URL}/api/profiles/${created.id}/screenshot`, { headers: authHeaders });
    const bytes = (await shot.arrayBuffer()).byteLength;
    check(shot.ok && bytes > 5000, 'screenshot captured', `${bytes} bytes`);

    step(`→ ${engine} persistence across a restart`);
    await assertPersistence(created.id);
  } finally {
    if (KEEP) {
      console.log(`\n   --keep: profile ${created.id} left running`);
    } else {
      await api(`/api/profiles/${created.id}`, { method: 'DELETE' }).catch(() => {});
    }
  }
}

async function main() {
  step('→ server');
  const status = await api('/api/status');
  console.log(`   chromium ${status.binary_version} | camoufox ${status.camoufox_version ?? 'not installed'}`);
  check(Boolean(status.camoufox_version), 'Camoufox is installed in the image');

  for (const engine of ENGINES) {
    await testEngine(engine);
  }

  console.log(
    failures === 0
      ? '\n\x1b[32m✓ all checks passed\x1b[0m'
      : `\n\x1b[31m✗ ${failures} check(s) failed\x1b[0m`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n\x1b[31mFATAL: ${err.message}\x1b[0m`);
  process.exit(1);
});
