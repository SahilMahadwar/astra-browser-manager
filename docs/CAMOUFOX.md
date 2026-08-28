# Writing and running Camoufox scripts

How to automate a Camoufox profile: what client to use, how to connect to one
running in the container, and the handful of ways it differs from Chromium.

For endpoint shapes and status codes see [API.md](API.md). This document is the
scripting guide.

- [The short version](#the-short-version)
- [Why Camoufox is different](#why-camoufox-is-different)
- [Setup](#setup)
- [Getting a profile running](#getting-a-profile-running)
- [Connecting](#connecting)
  - [Turning `automation_url` into a connect URL](#turning-automation_url-into-a-connect-url)
- [The one real gotcha: page globals](#the-one-real-gotcha-page-globals)
- [What ports from Chromium, and what doesn't](#what-ports-from-chromium-and-what-doesnt)
- [A complete scraper](#a-complete-scraper)
- [Reusing a logged-in session](#reusing-a-logged-in-session)
- [Proxies and fingerprint](#proxies-and-fingerprint)
- [Debugging](#debugging)
- [AI-driven automation](#ai-driven-automation)
- [Migrating a Stagehand script](#migrating-a-stagehand-script)
- [Troubleshooting](#troubleshooting)

## The short version

```ts
import { firefox } from 'playwright-core';

const browser = await firefox.connect('ws://host:8080/api/profiles/<id>/pw?token=…');
const context = browser.contexts()[0];              // the persistent profile
const page = context.pages()[0] ?? await context.newPage();

await page.goto('https://example.com');
await page.click('a.more-info');
const rows = await page.locator('.result').allInnerTexts();

await browser.close();                              // disconnects; profile keeps running
```

Four rules, and everything else is ordinary Playwright:

1. **`firefox.connect()`**, not `chromium.connectOverCDP()`.
2. **`ws://`** URL (or `wss://` behind TLS), not an `http://` base.
3. **`browser.contexts()[0]`** — never `newContext()`.
4. **Your Playwright version must match the server's.**

## Why Camoufox is different

Camoufox is Firefox 152. Firefox deleted its CDP implementation in version 141,
so there is no DevTools endpoint to attach to — `connectOverCDP` throws
`CDP connections are only supported by Chromium`, and no shim or flag changes
that. Camoufox is driven over Playwright's own protocol instead.

Practical consequences:

- **Stagehand, browser-use, Puppeteer and Selenium cannot drive it.** See
  [AI-driven automation](#ai-driven-automation).
- `cdp_url` is `null` for a Camoufox profile; read `automation_url` and
  `automation_protocol` instead.
- There is no `/json/version` or `/json/list`, so no target list to enumerate.

Everything above the protocol — the entire Playwright `Page` and `Locator`
API — is identical to Chromium.

## Setup

**Match the Playwright version to the server.** This is the single most common
setup failure, and on this server it fails in a way that does not look like a
version problem at all — see the warning below. The server's version is in
`server/package.json`; at time of writing it is `~1.60.0`.

```bash
npm i playwright-core@~1.60.0     # or the full `playwright` package
```

```bash
pip install "playwright~=1.60.0"
```

You do **not** need to run `playwright install` — no browser is downloaded
locally. The browser lives in the container; you are only connecting to it.

> **A mismatched client connects successfully and then misbehaves.**
>
> Playwright normally rejects a mismatched client at the handshake with
> `HTTP 428` and a clear "Playwright version mismatch" message. That guard does
> **not** fire here: the check reads the `Playwright/x.y.z` user-agent on the
> upgrade, and this server proxies the WebSocket, opening its own upstream
> connection without that header.
>
> So the connect succeeds, and then some calls work while others fail with:
>
> ```
> page.goto: timeout: expected float, got undefined
> ```
>
> Verified against a 1.62 client on a 1.60 server: `title()`, `evaluate()`,
> `cookies()` and `route()` worked, while `goto()`, `waitForSelector()`,
> `textContent()` and `screenshot()` all failed that way. It reads like a broken
> page or selector, so it costs hours if you do not know to suspect the version.
>
> If you see `expected float, got undefined`, check your Playwright version
> first.

## Getting a profile running

Create once, then launch whenever you need it. A profile is a durable identity —
create it once and reuse it, rather than making a new one per run.

```bash
# create
curl -s -X POST http://host:8080/api/profiles \
  -H "Authorization: Bearer $AUTH_TOKEN" -H 'content-type: application/json' \
  -d '{
        "name": "scraper-01",
        "engine": "camoufox",
        "engine_config": { "os": "windows", "humanize": true, "geoip": true },
        "proxy": "http://user:pass@proxy.example:8080",
        "screen_width": 1280, "screen_height": 800
      }'

# launch
curl -s -X POST http://host:8080/api/profiles/<id>/launch \
  -H "Authorization: Bearer $AUTH_TOKEN"
```

The launch response tells you how to connect:

```json
{
  "engine": "camoufox",
  "cdp_url": null,
  "automation_url": "/api/profiles/<id>/pw",
  "automation_protocol": "playwright-firefox"
}
```

**Write your connect logic against `automation_protocol`, not against a
hardcoded engine.** Then the same script drives either engine:

```ts
import { chromium, firefox } from 'playwright-core';

async function connect(base: string, profile: any, token?: string) {
  const q = token ? `?token=${encodeURIComponent(token)}` : '';

  if (profile.automation_protocol === 'playwright-firefox') {
    const ws = base.replace(/^http/, 'ws') + profile.automation_url + q;
    return firefox.connect(ws);
  }
  return chromium.connectOverCDP(base + profile.cdp_url + q);
}

const browser = await connect('http://host:8080', profile, process.env.AUTH_TOKEN);
const context = browser.contexts()[0];              // same line for both engines
```

Launch returns as soon as the browser is up, which is slightly before the
endpoint accepts connections. Either poll `GET /api/profiles/:id/cdp/alive` or
retry the connect for a few seconds.

## Connecting

### Turning `automation_url` into a connect URL

`GET /api/profiles/<id>` (and the launch response) gives you:

```json
{
  "engine": "camoufox",
  "automation_url": "/api/profiles/<id>/pw",
  "automation_protocol": "playwright-firefox",
  "cdp_url": null
}
```

Two things have to happen before that value can go into `firefox.connect()`:

1. **It is a relative path.** The REST API returns it that way because the
   dashboard is same-origin. An out-of-process client has to prefix its own
   scheme and host.
2. **The scheme must become `ws://`** — or `wss://` if you reach the manager over
   HTTPS. `firefox.connect()` takes a WebSocket URL, unlike `connectOverCDP()`,
   which takes an `http://` base and finds the socket itself. Passing an `http://`
   URL here is the most likely first mistake.

Then append `?token=` if the server has auth enabled:

```ts
const BASE = 'http://localhost:8080';          // or https://…
const TOKEN = process.env.AUTH_TOKEN ?? '';

const profile = await fetch(`${BASE}/api/profiles/${id}`, {
  headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
}).then((r) => r.json());

const ws =
  BASE.replace(/^http/, 'ws') +                                  // http→ws, https→wss
  profile.automation_url +                                       // /api/profiles/<id>/pw
  (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '');

const browser = await firefox.connect(ws);
const context = browser.contexts()[0];
```

`.replace(/^http/, 'ws')` handles both cases in one go: `http` → `ws` and
`https` → `wss`.

For a one-off script you can skip the API call entirely — the dashboard's
automation panel shows the **absolute** URL with a copy button, already in
`ws://` form with the token attached.

### Auth

When `AUTH_TOKEN` is set, pass it as `?token=` on the WebSocket URL.

This is not a convenience — it is the only channel available.
`firefox.connect()` accepts no headers option, so there is nowhere to put an
`Authorization` header. The server accepts `?token=` on the automation routes
specifically for this.

### Use `contexts()[0]`, never `newContext()`

`browser.contexts()[0]` is the profile's **persistent context** — the same
window shown in the live view, backed by the profile directory on disk, holding
its cookies and logins.

`newContext()` creates a throwaway context with none of that. It will appear to
work and quietly discard the identity the profile exists to keep.

```ts
const context = browser.contexts()[0];              // ✅
const context = await browser.newContext();         // ❌ loses the profile
```

### Disconnecting is safe; closing is not what you think

`browser.close()` from a client **disconnects that client**. The profile keeps
running, the window stays open in the live view, and other clients stay
connected. The server owns the session lifecycle.

To actually stop the profile, call the API:

```bash
curl -X POST http://host:8080/api/profiles/<id>/stop -H "Authorization: Bearer $AUTH_TOKEN"
```

### Multiple clients at once

Several clients may hold connections to the same profile simultaneously — they
all see the same context and the same pages. Useful for attaching a debugger to
a running scrape, and it is how the manager itself takes screenshots while your
script drives.

It also means two scripts driving one profile will fight over the same tabs. Use
one profile per concurrent worker.

## The one real gotcha: page globals

**This is the only thing that will silently break a scraper ported from
Chromium, so read it even if you skip the rest.**

`page.evaluate()` runs in an **isolated world** on Camoufox. It can read and
write the DOM normally — but it **cannot see JavaScript globals defined by the
page**. They come back `undefined`, with no error.

That breaks the common trick of reading a framework's state blob:

```ts
// Chromium: returns the object.  Camoufox: returns undefined, silently.
const data = await page.evaluate('window.__NEXT_DATA__');
await page.evaluate('window.dataLayer');
await page.evaluate('window.__NUXT__');
```

DOM work is unaffected and needs no special handling:

```ts
await page.evaluate("document.querySelector('h1').textContent = 'x'");   // works
await page.evaluate("document.querySelectorAll('.row').length");         // works
```

### Three ways to read page globals

**1. Parse the script tag** — portable, works on every engine, no configuration:

```ts
const raw = await page.locator('script#__NEXT_DATA__').textContent();
const data = JSON.parse(raw ?? '{}');
```

**2. Turn on main-world eval** and use the `mw:` prefix. Set
`engine_config.main_world_eval: true` on the profile, then:

```ts
const data = await page.evaluate('mw:JSON.stringify(window.__NEXT_DATA__)');
```

Note the trade: main-world execution is detectable by the page, which is
precisely why Camoufox isolates by default. Turn it on only where you need it.

Using `mw:` without enabling it fails loudly rather than silently, which is what
you want:

```
page.evaluate: Main world evaluation is disabled.
Launch with main_world_eval=True to use the "mw:" prefix.
```

**3. Intercept the network response** the data came from, which is often
cleaner than scraping the rendered page at all:

```ts
const [res] = await Promise.all([
  page.waitForResponse((r) => r.url().includes('/api/search')),
  page.click('button.search'),
]);
const data = await res.json();
```

## What ports from Chromium, and what doesn't

**Ports unchanged.** The whole Playwright surface: `goto`, `locator`, `click`,
`fill`, `selectOption`, `evaluate`, `waitForSelector`, `waitForLoadState`,
`waitForResponse`, `route`, `screenshot`, `addInitScript`, `cookies`,
`storageState`, frames, downloads, dialogs. A Firefox `Page` and a Chromium
`Page` are the same type with the same methods. If your scraper is selectors and
waits, the connection line is the only edit.

**Does not port:**

| Chromium-only | What to do instead |
| --- | --- |
| `context.newCDPSession(page)` | No equivalent. Fails with `CDP session is only available in Chromium`. |
| Raw CDP commands | Use the Playwright API; there is no protocol escape hatch. |
| Stagehand `act()` / `extract()` / `observe()` | See [below](#ai-driven-automation). |
| `window.__SOME_GLOBAL__` via `evaluate` | See [above](#the-one-real-gotcha-page-globals). |

Behavioural differences worth knowing, none Camoufox-specific — they are just
Firefox:

- Firefox is stricter about clicking elements that are covered or off-screen.
  Prefer `locator.click()` (which auto-waits and scrolls) over `evaluate`-based
  clicking.
- No `--disable-blink-features` style flags; Camoufox is configured through
  `engine_config`, not command-line arguments.

## A complete scraper

```ts
import { firefox, type Browser, type BrowserContext } from 'playwright-core';

const BASE = process.env.MANAGER_URL ?? 'http://localhost:8080';
const TOKEN = process.env.AUTH_TOKEN ?? '';
const PROFILE = process.env.PROFILE_ID!;

const headers = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};
const q = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '';

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...headers, ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

/** Launch if needed, then connect, retrying while the endpoint comes up. */
async function open(): Promise<{ browser: Browser; context: BrowserContext }> {
  let profile = await api(`/api/profiles/${PROFILE}`);
  if (profile.status !== 'running') {
    await api(`/api/profiles/${PROFILE}/launch`, { method: 'POST' });
    profile = await api(`/api/profiles/${PROFILE}`);
  }
  if (profile.automation_protocol !== 'playwright-firefox') {
    throw new Error(`expected a camoufox profile, got ${profile.engine}`);
  }

  const ws = BASE.replace(/^http/, 'ws') + profile.automation_url + q;

  let lastError: unknown;
  for (let i = 0; i < 10; i++) {
    try {
      const browser = await firefox.connect(ws);
      return { browser, context: browser.contexts()[0] };
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastError;
}

async function main() {
  const { browser, context } = await open();
  try {
    const page = context.pages()[0] ?? (await context.newPage());

    await page.goto('https://news.ycombinator.com/', { waitUntil: 'domcontentloaded' });

    // Wait for real content, never a fixed sleep.
    await page.waitForSelector('.titleline', { timeout: 30_000 });

    const items = await page.locator('.athing').evaluateAll((rows) =>
      rows.map((row) => ({
        rank: row.querySelector('.rank')?.textContent?.replace('.', '').trim(),
        title: row.querySelector('.titleline a')?.textContent?.trim(),
        url: row.querySelector('.titleline a')?.getAttribute('href'),
      }))
    );

    console.log(JSON.stringify(items.slice(0, 5), null, 2));
  } finally {
    // Disconnects only. The profile stays up for the next run, keeping its
    // cookies warm — call /stop when you actually want it down.
    await browser.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
```

Python is the same shape:

```python
import asyncio, os
from playwright.async_api import async_playwright

async def main():
    base = os.environ.get("MANAGER_URL", "http://localhost:8080")
    token = os.environ.get("AUTH_TOKEN", "")
    q = f"?token={token}" if token else ""
    ws = base.replace("http", "ws", 1) + f"/api/profiles/{os.environ['PROFILE_ID']}/pw" + q

    async with async_playwright() as pw:
        browser = await pw.firefox.connect(ws)
        context = browser.contexts[0]
        page = context.pages[0] if context.pages else await context.new_page()
        await page.goto("https://example.com", wait_until="domcontentloaded")
        print(await page.title())
        await browser.close()

asyncio.run(main())
```

## Reusing a logged-in session

This is the main reason to use profiles rather than throwaway browsers. Cookies,
`localStorage`, IndexedDB and saved logins live in the profile directory and
survive stop/relaunch.

The pattern: log in once, by hand, through the live view at
`http://host:8080` — solving any CAPTCHA or 2FA yourself — then have every
subsequent run connect and find itself already authenticated.

```ts
const page = context.pages()[0] ?? (await context.newPage());
await page.goto('https://site.example/dashboard');

if (page.url().includes('/login')) {
  throw new Error(
    `Profile ${PROFILE} is logged out. Open the live view and sign in again.`
  );
}
```

Do not re-log-in from the script on every run if you can avoid it — repeated
logins from automation are a much stronger detection signal than a long-lived
session.

## Proxies and fingerprint

Both are profile settings, not script settings, so every connection inherits
them automatically.

Set `proxy` on the profile (`http://user:pass@host:port`, or `socks5://…`).
Firefox handles proxy authentication natively, so no local relay is needed.
Verify one before assigning it:

```bash
curl -s -X POST http://host:8080/api/proxy/test \
  -H "Authorization: Bearer $AUTH_TOKEN" -H 'content-type: application/json' \
  -d '{"proxy":"http://user:pass@proxy.example:8080"}'
```

Useful `engine_config` keys for scraping — the full list is in
[API.md](API.md#camoufoxconfig):

| Key | Why you'd set it |
| --- | --- |
| `os` | Spoofed OS. Drives UA, fonts and GPU together — set it, don't leave it random, if you want a stable identity. |
| `geoip` | Derives timezone, locale and WebRTC IP from the proxy's exit IP. Turn this on whenever you use a proxy; a UK proxy with a New York timezone is an obvious tell. |
| `humanize` | Human-like cursor movement between clicks. Costs a little wall time per action. |
| `block_images` | Large bandwidth saving on image-heavy pages. Detectable in principle; fine for most scraping. |
| `main_world_eval` | Only if you need `mw:` — see above. |
| `block_webgl` | Rarely wanted. A missing WebGL context is itself a signal. |

Changes take effect on the **next launch**, so stop and relaunch after editing.

## Debugging

**Watch it happen.** Open `http://host:8080`, pick the profile, and you get a
live VNC view of the real window while your script drives it. This is by far the
fastest way to understand why a selector missed.

**Grab a screenshot** from outside the script at any time:

```bash
curl -s http://host:8080/api/profiles/<id>/screenshot -H "Authorization: Bearer $AUTH_TOKEN" -o shot.jpg
```

**Slow it down** to see what is happening:

```ts
await page.goto(url);
await page.waitForTimeout(2000);   // debugging only — never as a wait strategy
```

**Check liveness** if a connect hangs:

```bash
curl -s http://host:8080/api/profiles/<id>/cdp/alive -H "Authorization: Bearer $AUTH_TOKEN"
```

**Leave the profile running between runs** while iterating. Reconnecting to a
warm profile is much faster than relaunching, and you keep the page state you
were debugging.

## AI-driven automation

**Stagehand does not work with Camoufox, in any version.** It attaches over CDP
and is Chromium-only by its own documentation ("Stagehand has no Firefox or
WebKit support"). This is not a limitation of this server — nothing can drive
Firefox over CDP.

If you want natural-language `act`/`extract` against a Camoufox profile, these
are the realistic options. **None of them is a tested, supported Firefox
configuration — budget time to smoke-test before committing.**

| Option | Why it can work | Catch |
| --- | --- | --- |
| **Midscene.js** (TS) | Takes an arbitrary Playwright `Page`/`BrowserContext`; its act/extract loop is `page.mouse` / `page.keyboard` / `page.evaluate` plus a vision model, not CDP. Its docs cover connecting to a remote Playwright browser. | Its own docs say Firefox "may work… may report errors". The MJPEG live-view feature is CDP-backed and will throw — disable it. |
| **Notte** (Python) | Its browser layer literally calls `playwright.firefox.connect(url)` for `browser_type="firefox"`. | Firefox is an undocumented code path; the public docs advertise Chromium only. |
| **Playwright MCP** | First-party Microsoft; supports `browserName: 'firefox'` with a `remoteEndpoint` WebSocket — exactly this endpoint. | Gives you tools, not an SDK. You assemble the agent loop. |

Confirmed **not** viable: Stagehand, browser-use (Chromium via CDP, Playwright
removed entirely), Skyvern. Do not try to fork these.

The pragmatic alternative is to keep the AI where it earns its cost and use
selectors elsewhere — see below.

## Migrating a Stagehand script

Most Stagehand scrapers are mostly plain Playwright with a few AI calls. Only
the AI calls need real work.

| Stagehand | Camoufox equivalent |
| --- | --- |
| `new Stagehand({ localBrowserLaunchOptions: { cdpUrl } })` + `stagehand.init()` | `await firefox.connect(wsUrl)` |
| `stagehand.context` | `browser.contexts()[0]` |
| `page.goto` / `locator` / `click` / `fill` / `evaluate` | unchanged |
| `stagehand.observe(...)` then `act(result)` | a CSS selector, usually more reliable anyway |
| `stagehand.act('Click the X tab')` | `page.click('…')` |
| `stagehand.extract(prompt, zodSchema)` | see below |

**`extract()` is the easy one**, because it is really *HTML → LLM → JSON* and
never touches the browser protocol. Keep your existing prompt and zod schema:

```ts
import { z } from 'zod';

async function extract<T extends z.ZodTypeAny>(page: any, instruction: string, schema: T) {
  // innerText rather than full HTML: far fewer tokens, and usually enough.
  const text = await page.locator('body').innerText();

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Extract the requested data. Reply with JSON only.' },
        { role: 'user', content: `${instruction}\n\n---\n${text.slice(0, 100_000)}` },
      ],
    }),
  });

  const json = JSON.parse((await res.json()).choices[0].message.content);
  return schema.parse(json) as z.infer<T>;
}
```

That function works against either engine, so you can migrate incrementally.

**`act()` is the harder one**, because it needs to decide *what* to click from
the DOM. In practice most `act()` calls in a mature scraper are "click the named
tab" or "type into that search box", and a selector is both cheaper and more
reliable. For the ones that genuinely need reasoning, either adopt one of the
tools above or keep a Chromium profile for those steps — both engines run side
by side in the same manager, so you can mix per step.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `timeout: expected float, got undefined` on `goto` / `waitForSelector` / `screenshot` | **Playwright version mismatch.** The usual `HTTP 428` guard does not fire through this proxy, so the connect succeeds and individual calls fail instead. Match the version in `server/package.json`. |
| `Playwright version mismatch: server version vX / client version vY` | The same problem, reported properly — you are connecting directly to the endpoint rather than through the proxy. Match the versions. |
| `browser.contexts()` is empty | You connected to a profile that is not fully up, or to the wrong endpoint. Retry the connect; check `GET /api/profiles/:id/cdp/alive`. |
| WebSocket closes with **4004** | Profile is not running. Launch it first. |
| WebSocket closes with **4005** | The browser is wedged. `POST /api/profiles/:id/force-stop`, then launch again. |
| WebSocket closes with **4006** | Wrong endpoint for the engine — you used `/cdp` on a Camoufox profile or `/pw` on a Chromium one. Branch on `automation_protocol`. |
| WebSocket closes with **4403** | Origin/Host mismatch. Browsers send `Origin` on upgrade; scripts normally do not. |
| `401 Unauthorized` | Missing token. On `/pw` it must be `?token=`, not a header. |
| `CDP connections are only supported by Chromium` | You called `connectOverCDP` on a Camoufox profile. Use `firefox.connect`. |
| `window.__X__` is `undefined` but works in Chrome | Isolated world. See [page globals](#the-one-real-gotcha-page-globals). |
| `Main world evaluation is disabled` | Set `engine_config.main_world_eval: true` and relaunch. |
| `CDP session is only available in Chromium` | `newCDPSession` has no Firefox equivalent; use the Playwright API. |
| Profile stops when the script ends | You called the stop endpoint, or the container restarted. `browser.close()` alone does not stop a profile. |
| Everything is slow after enabling `humanize` | Expected — it moves the cursor realistically between actions. Lower it or turn it off for bulk scraping. |
