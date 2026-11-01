# API Reference

AstraBrowser Manager runs isolated stealth-browser profiles in one Docker container.
Each profile has its own fingerprint, proxy, cookies and on-disk session, and can be
watched live in the web UI while code drives it.

Everything is served from one port (`8080` by default): the web UI, a REST API, an MCP
server, and WebSocket proxies for automation and the live view.

This document is self-contained. An agent or integrator should not need anything else
to use the system.

- [What you can do](#what-you-can-do)
- [What you cannot do](#what-you-cannot-do)
- [Choosing an engine](#choosing-an-engine)
- [Choosing an interface](#choosing-an-interface)
- [End-to-end example](#end-to-end-example)
- [Conventions](#conventions)
- [Authentication](#authentication)
- [Profiles](#profiles)
- [Export & import](#export--import)
- [Launch & stop](#launch--stop)
- [Automation](#automation)
- [Writing Camoufox scripts](#writing-camoufox-scripts)
- [WebSocket endpoints](#websocket-endpoints)
- [Live view](#live-view)
- [Screenshots](#screenshots)
- [Clipboard](#clipboard)
- [Proxy testing](#proxy-testing)
- [System & binary](#system--binary)
- [MCP](#mcp)
- [Type reference](#type-reference)
- [Deployment settings that affect clients](#deployment-settings-that-affect-clients)
- [Troubleshooting](#troubleshooting)

## What you can do

| Goal | How |
| --- | --- |
| Create a durable browser identity | `POST /api/profiles`, or MCP `create_profile` |
| Choose Chromium or Firefox per profile | `engine` at creation |
| Give it a proxy, timezone, locale, screen size and fingerprint | Profile fields; see [ProfileCreate](#profilecreate) |
| Check a proxy and see its exit IP before using it | `POST /api/proxy/test`, or MCP `test_proxy` |
| Start and stop the browser | `POST /api/profiles/:id/launch` and `/stop`, or MCP tools |
| Recover a hung session | `POST /api/profiles/:id/force-stop` |
| Start profiles when the manager starts | `auto_launch: true` |
| Drive pages with Playwright or Puppeteer | Connect to the [automation endpoint](#automation) |
| Read or set cookies, storage and page content | Through your Playwright or Puppeteer connection |
| Keep logins across runs | Automatic: the user-data directory survives stop and relaunch |
| See what a browser is showing | `GET /api/profiles/:id/screenshot`, or MCP `take_screenshot` |
| Hand a browser to a human (login, CAPTCHA, 2FA) | Send them to the [live view](#live-view) |
| Exchange text with the browser's clipboard | `/api/profiles/:id/clipboard` |
| Move profile configuration between installs | [Export & import](#export--import) |
| Check or update browser binaries | [System & binary](#system--binary) |

## What you cannot do

These are deliberate or structural limits, so do not spend time looking for a way around
them.

- **No page actions over REST or MCP.** There is no navigate, click or type endpoint. Both
  are control planes. Pages are driven over the automation endpoint.
- **No cookie or session API.** Export carries configuration only, never cookies. Read
  session state through your automation client, for example `context.cookies()`.
- **No CDP on Camoufox.** Firefox removed it in version 141. Stagehand and other CDP-only
  tools cannot drive these profiles.
- **Camoufox cannot be driven through MCP.** MCP can manage these profiles, but automation
  uses Playwright over REST-discovered URLs.
- **`engine` cannot change after creation.** The profile directory is in that engine's own
  format. Create a new profile instead.
- **No events or webhooks.** Poll `/status` or `GET /api/profiles`.
- **No list filtering or pagination.** `GET /api/profiles` returns every profile, newest
  first. Filter on the client.
- **One shared token.** There are no users, roles or per-profile permissions.
- **One instance only.** Sessions live in the server's memory, so it cannot be replicated.
  A restart stops every browser; only `auto_launch` profiles come back on their own.
- **Launching requires the Docker image**, or a host with KasmVNC and the browser binaries.
  Elsewhere CRUD still works, but launch returns `500`.

## Choosing an engine

| | `chromium` (default) | `camoufox` |
| --- | --- | --- |
| Browser | CloakBrowser stealth Chromium | Camoufox stealth Firefox |
| Automation protocol | CDP | Playwright protocol |
| Endpoint | `/api/profiles/<id>/cdp` | `/api/profiles/<id>/pw` |
| Connect with | `chromium.connectOverCDP(url)`, Puppeteer | `firefox.connect(wsUrl)` only |
| Client version | Flexible | **Must match the server's Playwright, currently `~1.60`** |
| Drivable from MCP's `cdp_url` | Yes | No |
| Stagehand and other CDP tools | Yes | No |
| Reads page JS globals with `evaluate` | Yes | Not by default; see [page globals](#page-globals) |
| Fingerprint comes from | `fingerprint_seed` and flat fields | `engine_config` |

Both engines share the UI, proxy support, live view, screenshots and session persistence.

Use `chromium` unless you specifically want a Firefox fingerprint. It works with more
tools and has fewer client constraints.

**Branch on `automation_protocol`, not on `engine` or on `cdp_url` being present.**

## Choosing an interface

| Interface | Use it for |
| --- | --- |
| **REST** (`/api/*`) | Services and scripts. Covers everything, including Camoufox automation URLs, export/import, clipboard and binaries. |
| **MCP** (`/mcp`) | LLM agents managing profiles as tools. Launches can wait until the browser is ready, and URLs are absolute. Has no export/import, clipboard, binary or status-summary tools. |
| **Automation WebSockets** | The page-level work, for either interface. |

## End-to-end example

Creates a profile, launches it, drives it and disconnects. The same code handles both
engines, including auth.

```ts
import { chromium, firefox } from 'playwright-core'; // pin ~1.60 for Camoufox

const BASE = process.env.ASTRA_URL ?? 'http://localhost:8080';
const TOKEN = process.env.AUTH_TOKEN ?? '';
const query = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '';

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// A profile is a durable identity: create it once and store the id.
const created = await api('/api/profiles', {
  method: 'POST',
  body: JSON.stringify({
    name: 'scraper-01',
    engine: 'chromium', // or 'camoufox'
    proxy: 'http://user:pass@proxy.example:8000',
    timezone: 'America/New_York',
    locale: 'en-US',
  }),
});
const id = created.id;

const launched = await api(`/api/profiles/${id}/launch`, { method: 'POST' });

// REST launch can return just before the endpoint accepts connections.
for (let i = 0; i < 60; i++) {
  const { alive } = await api(`/api/profiles/${id}/cdp/alive`);
  if (alive) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}

// REST URLs are relative, and the two protocols need different URL schemes.
const browser =
  launched.automation_protocol === 'playwright-firefox'
    ? await firefox.connect(BASE.replace(/^http/, 'ws') + launched.automation_url + query)
    : await chromium.connectOverCDP(BASE + launched.automation_url + query);

const context = browser.contexts()[0]; // the persistent profile, never newContext()
const page = context.pages()[0] ?? (await context.newPage());
await page.goto('https://example.com');
console.log(await page.title());

await browser.close(); // disconnects only; the profile keeps running

await api(`/api/profiles/${id}/stop`, { method: 'POST' });
```

`.replace(/^http/, 'ws')` maps `http` to `ws` and `https` to `wss`.

## Conventions

| | |
| --- | --- |
| Base URL | `http://localhost:8080`, or wherever the container is published |
| Prefix | REST routes live under `/api`. MCP is at `/mcp`. |
| Content type | JSON in and out, except screenshots (`image/jpeg`) |
| Field naming | `snake_case` everywhere. These names are a wire contract. |
| IDs | UUID strings assigned at creation |
| Timestamps | ISO 8601, e.g. `2026-11-01T04:32:15.042000+00:00` |

Errors:

| Case | Response |
| --- | --- |
| Expected failure | `{ "detail": "<message>" }` with a 4xx or 5xx status |
| Validation failure | `422` with `{ "detail": [ ...Zod issues... ] }` |
| Unknown `/api/*` route | `404` with `{ "detail": "Not found" }` |
| Unhandled server error | `500` with the plain text body `Internal Server Error`, **not JSON** |

A malformed JSON body is read as an empty one, so `POST /api/profiles` reports a missing
`name` rather than a parse error.

Unknown body fields are silently dropped, including misspelled ones. Check the response if
a setting appears not to apply.

## Authentication

Authentication is **off by default**. Setting `AUTH_TOKEN` on the server turns it on, and
every `/api/*` route and `/mcp` then requires that token. There is a single shared token.

| Channel | Works on | Notes |
| --- | --- | --- |
| `Authorization: Bearer <token>` | Every guarded route | The normal choice for API clients |
| `auth_token` cookie | Every guarded route | Set by `POST /api/auth/login`; used by the web UI |
| `?token=<token>` | **`/api/profiles/<id>/cdp` and `/pw`, and paths below them, only** | For clients that cannot send headers |

`?token=` is rejected everywhere else with `401`, including `/api/profiles`,
`/api/profiles/<id>/status`, `/api/profiles/<id>/vnc` and `/mcp`. Tokens in URLs leak into
logs and error traces, so it is limited to the clients that need it. Stagehand only accepts
a bare CDP URL, and `firefox.connect()` has no headers option, so for Camoufox the query
parameter is the only channel. URL-encode the token.

These routes never require auth: `/api/auth/status`, `/api/auth/login`, `/api/status`. The
static UI also loads without a token and shows a login page.

A guarded request without a valid token returns `401 {"detail":"Unauthorized"}`. WebSocket
upgrades are rejected the same way, with HTTP `401` before the socket opens.

### `GET /api/auth/status`

```json
{ "auth_required": true, "authenticated": false }
```

With auth disabled this returns `auth_required: false` and `authenticated: false`, so check
`auth_required` first.

### `POST /api/auth/login`

```json
{ "token": "your-token" }
```

On success, sets the `auth_token` session cookie (`HttpOnly`, `SameSite=Strict`, `Path=/`,
plus `Secure` when `x-forwarded-proto` contains `https`) and returns `{"ok": true}`. The
cookie's value is the token itself. A wrong or malformed token returns
`401 {"detail":"Invalid token"}`. When auth is disabled it returns `{"ok": true}` and sets
nothing.

### `POST /api/auth/logout`

Clears the cookie and returns `{"ok": true}`.

## Profiles

### `GET /api/profiles`

Every profile with its live status, newest first. Returns an array of
[`ProfileResponse`](#profileresponse).

```bash
curl -H "Authorization: Bearer $AUTH_TOKEN" localhost:8080/api/profiles
```

Responses include the stored `proxy` value, **credentials included**. Treat them as secrets.

### `POST /api/profiles`

Creates a profile. Only `name` is required, and names do not have to be unique. See
[`ProfileCreate`](#profilecreate). Creating does not launch the browser.

```bash
curl -X POST localhost:8080/api/profiles \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
        "name": "scraper-01",
        "proxy": "http://user:pass@host:8000",
        "timezone": "America/New_York",
        "tags": [{ "tag": "scraping", "color": "#22c55e" }]
      }'
```

A Camoufox profile:

```bash
curl -X POST localhost:8080/api/profiles \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
        "name": "fox-01",
        "engine": "camoufox",
        "engine_config": { "os": "windows", "humanize": true, "geoip": true },
        "proxy": "http://user:pass@host:8000",
        "screen_width": 1280,
        "screen_height": 800
      }'
```

Returns `201` with the [`ProfileResponse`](#profileresponse), or `422`.

Things creation does **not** check, because they only fail later at launch:

- The `proxy` string. A bad one gets a `400` at launch.
- The contents of `engine_config`. A bad value gets a generic `500` at launch, and unknown
  keys are stored but ignored. Validate these values before sending them.

Leave `fingerprint_seed` unset. A random seed (10000–99999) is generated per profile, and
sharing one across Chromium profiles makes them look like the same machine.

Reuse profiles rather than creating one per run. An aged profile with real session history
is the point of the system.

### `GET /api/profiles/:id`

One [`ProfileResponse`](#profileresponse). `404` if unknown.

### `PUT /api/profiles/:id`

Partial update. **Only keys present in the body are written.** See
[`ProfileUpdate`](#profileupdate). Changes take effect on the **next launch**, so a running
profile must be stopped and relaunched to pick them up.

Returns the updated [`ProfileResponse`](#profileresponse), `404` if unknown, or `422` if
invalid.

Sending `engine` does nothing: it is dropped and the request still returns `200`.

### `DELETE /api/profiles/:id`

Stops the browser if running, then permanently removes the database row, the user-data
directory (cookies, localStorage, logins) and the cached thumbnail. **This cannot be
undone.**

Returns `{"ok": true}`, or `404`.

## Export & import

These move configuration only. **Cookies and session data are never included**, so an
imported profile starts logged out.

Exports contain proxy credentials in clear text. They also contain `fingerprint_seed`, so
importing onto the same install creates a Chromium profile with the *same* fingerprint as
the original. To clone a profile as a new identity, delete `fingerprint_seed` from the entry
first.

### `GET /api/profiles/export`

All profiles as a [`ProfileExport`](#profileexport) envelope, with
`Content-Disposition: attachment; filename="astrabrowser-profiles.json"`. The fields `id`,
`user_data_dir`, `created_at` and `updated_at` are stripped.

### `GET /api/profiles/:id/export`

The same envelope for one profile, with a filename derived from its name
(`"My Profile!"` becomes `my-profile.json`). `404` if unknown.

### `POST /api/profiles/import`

Accepts the envelope or a bare array of profile objects.

```json
{
  "created": 3,
  "skipped": [{ "name": "broken", "reason": "..." }],
  "renamed": [{ "from": "scraper-01", "to": "scraper-01 (imported)" }]
}
```

- **Schema check first, all or nothing.** If any entry fails validation, the whole request
  returns `422` and nothing is created.
- **Then per-entry.** A database failure on one entry adds it to `skipped`, and the batch
  continues.
- **Names never collide.** A taken name becomes `Name (imported)`, then
  `Name (imported 2)`, and each change is listed in `renamed`.

## Launch & stop

Lifecycle: `stopped` → `launch` → `running` → `stop` → `stopped`.

Running state is held in memory. A profile also becomes `stopped` by itself if its browser
crashes or a person closes its window in the live view.

### `POST /api/profiles/:id/launch`

No request body. Starts an Xvnc display and the profile's browser. Allow a few seconds.

```json
{
  "profile_id": "68a37e97-…",
  "status": "running",
  "engine": "chromium",
  "vnc_ws_port": 6100,
  "display": ":100",
  "cdp_url": "/api/profiles/68a37e97-…/cdp",
  "automation_url": "/api/profiles/68a37e97-…/cdp",
  "automation_protocol": "cdp"
}
```

For Camoufox, `cdp_url` is `null`, `automation_url` ends in `/pw`, and `automation_protocol`
is `playwright-firefox`.

`vnc_ws_port` and `display` describe loopback-only resources inside the container. **They
cannot be connected to from outside.** Use the proxied routes on port 8080.

| Code | Body | Meaning |
| --- | --- | --- |
| `200` | Above | Launched |
| `400` | The specific reason | Bad proxy (scheme, host or port) or missing seed. Safe to show a user, but may echo the proxy URL **including credentials**. |
| `404` | `Profile not found` | |
| `409` | `Profile is already running` | |
| `500` | `Failed to launch browser` | Server-side failure. See below. |

A `500` deliberately hides the cause from REST callers, and it is in the server log. MCP's
`launch_profile` returns the actual message. Common causes:

- Invalid values in `engine_config`, which is not validated at creation
- Two simultaneous launches of one profile (the second gets a `500`, not a `409`)
- Running outside Docker, where the log says `Xvnc failed to start … ENOENT`
- All 100 automation ports (5100–5199) in use

**REST launch does not wait for the automation endpoint to accept connections.** Poll
[`/cdp/alive`](#get-apiprofilesidcdpalive) before connecting. MCP's `launch_profile` does
that for you.

### `POST /api/profiles/:id/stop`

Graceful stop: closes the browser, which flushes cookies to disk, then tears down the
display. The user-data directory is kept for the next launch.

Returns `{"ok": true}`, or `404 {"detail":"Profile is not running"}`. Unknown ids also get
this `404`.

**Prefer `stop` over `force-stop` or killing the container.** A clean shutdown is what
persists recent session state.

### `POST /api/profiles/:id/force-stop`

For a wedged session. Drops the profile from tracking and tears down the display right away,
**without waiting on the browser**, then attempts to close the browser in the background.
Use it when `stop` hangs or when a profile reports `running` but `alive` is `false`.

Returns `{"ok": true}`, or `404 {"detail":"Profile is not running"}`.

### `GET /api/profiles/:id/status`

Liveness only, and cheaper than fetching the profile.

```json
{
  "status": "running",
  "engine": "chromium",
  "vnc_ws_port": 6100,
  "display": ":100",
  "cdp_url": "/api/profiles/…/cdp",
  "automation_url": "/api/profiles/…/cdp",
  "automation_protocol": "cdp"
}
```

A stopped profile returns `"stopped"` with **every other field `null`, including `engine`**.
Read a stopped profile's engine from `GET /api/profiles/:id`. `404` if unknown.

`running` only means the session is tracked. To confirm the browser is answering, use
`/cdp/alive`.

## Automation

Every running profile has one automation endpoint, proxied through this server. The session
can be driven and watched in the live view at the same time.

| `automation_protocol` | Endpoint | URL scheme you pass | Connect with |
| --- | --- | --- | --- |
| `cdp` | `/api/profiles/<id>/cdp` | `http(s)://` or `ws(s)://` | `chromium.connectOverCDP(url)`, `puppeteer.connect` |
| `playwright-firefox` | `/api/profiles/<id>/pw` | **`ws(s)://` only** | `firefox.connect(wsUrl)` |

Rules for both engines:

- **Use `browser.contexts()[0]`, never `newContext()`.** That is the persistent profile, the
  same window shown in the live view. A new context is a throwaway that looks like it works
  but has none of the profile's cookies or logins.
- **Use one profile per concurrent worker.** All connected clients share the same tabs and
  will interfere with each other.
- **Proxy and fingerprint are profile settings.** Every connection inherits them, and scripts
  should not try to set them.

REST returns `cdp_url` and `automation_url` as **relative paths**, so out-of-process clients
must prefix their own scheme and host. MCP returns an **absolute** `cdp_url`, built from
`PUBLIC_BASE_URL` if set, otherwise the request's scheme and `Host`.

Neither API adds your token to these URLs. With auth on, append `?token=` or send a header.

### Disconnecting without stopping the profile

| Client | Call | Effect |
| --- | --- | --- |
| Playwright, either engine | `browser.close()` | Disconnects. The profile keeps running. |
| Puppeteer | `browser.disconnect()` | Disconnects. The profile keeps running. |
| Puppeteer | `browser.close()` | **Sends CDP `Browser.close`, which shuts Chromium down and stops the profile.** |

### Chromium (CDP)

```javascript
const { chromium } = require("playwright");

const browser = await chromium.connectOverCDP(
  "http://localhost:8080/api/profiles/<profile-id>/cdp",
  // With auth, either send a header...
  { headers: { Authorization: `Bearer ${process.env.AUTH_TOKEN}` } },
);
// ...or append ?token=<token> to the URL instead.
const context = browser.contexts()[0];
const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://example.com");
await browser.close(); // disconnects only
```

```python
from playwright.async_api import async_playwright

async with async_playwright() as pw:
    browser = await pw.chromium.connect_over_cdp(
        "http://localhost:8080/api/profiles/<profile-id>/cdp?token=<token>"
    )
    context = browser.contexts[0]
    page = context.pages[0] if context.pages else await context.new_page()
    await page.goto("https://example.com")
```

```javascript
const puppeteer = require("puppeteer-core");

const browser = await puppeteer.connect({
  browserURL: "http://localhost:8080/api/profiles/<profile-id>/cdp?token=<token>",
});
const [page] = await browser.pages();
await page.goto("https://example.com");
browser.disconnect(); // not close()
```

Stagehand takes the same URL through `localBrowserLaunchOptions.cdpUrl`, with the token as
a query parameter.

#### Human-like input on Chromium

The Chromium `humanize` field patches the Playwright objects inside the **manager's own
process**. A remote client has separate `Page` objects, so its clicks and typing are **not
humanized by this setting**. If you need it from a client, `cloakbrowser` exports
`humanizeBrowser`, which has not been tested against this setup. On Camoufox, humanization
is handled by the browser itself; see [`engine_config.humanize`](#camoufoxconfig).

### Camoufox (Playwright protocol)

```javascript
const { firefox } = require("playwright");

const browser = await firefox.connect(
  "ws://localhost:8080/api/profiles/<profile-id>/pw?token=<token>",
);
const context = browser.contexts()[0];
const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://example.com");
await browser.close(); // disconnects only
```

```python
from playwright.async_api import async_playwright

async with async_playwright() as pw:
    browser = await pw.firefox.connect(
        "ws://localhost:8080/api/profiles/<profile-id>/pw?token=<token>"
    )
    context = browser.contexts[0]
    page = context.pages[0] if context.pages else await context.new_page()
    await page.goto("https://example.com")
```

See [Writing Camoufox scripts](#writing-camoufox-scripts) for the version requirement and
behavior differences.

### How WebSocket URLs are rewritten

Chrome reports its debugger URLs as `ws://127.0.0.1:<internal-port>/devtools/...`, which is
unreachable from outside. The discovery routes rewrite them to:

```
ws(s)://<host>/api/profiles/<id>/cdp[?token=…]                      # browser target
ws(s)://<host>/api/profiles/<id>/cdp/devtools/<suffix>[?token=…]    # page target
```

- `<host>` is the request's `Host` header. **`PUBLIC_BASE_URL` is not used here.**
- The scheme is `wss` when `x-forwarded-proto` contains `https`.
- `?token=` is echoed **only if the caller sent it as a query parameter**. Clients using a
  header or cookie get a bare URL and must send those again on the upgrade.

If a reverse proxy rewrites `Host`, HTTP discovery returns a URL pointing at the wrong
place. Pass the public `wss://…/cdp` URL straight to `connectOverCDP` to skip discovery.

### `GET /api/profiles/:id/cdp`

Chromium only. Without an upgrade header, returns a descriptor:

```json
{
  "cdp_url": "/api/profiles/…/cdp",
  "automation_url": "/api/profiles/…/cdp",
  "automation_protocol": "cdp",
  "usage": "playwright.chromium.connect_over_cdp('http://<host>/api/profiles/…/cdp')"
}
```

With `Upgrade: websocket`, the same path is the browser-level CDP proxy.

`404` when not running. `409` for a Camoufox profile.

### `GET /api/profiles/:id/pw`

Camoufox only. The same pattern: a descriptor over plain HTTP, the WebSocket proxy on
upgrade.

```json
{
  "automation_url": "/api/profiles/…/pw",
  "automation_protocol": "playwright-firefox",
  "usage": "const browser = await firefox.connect('ws://<host>/api/profiles/…/pw');\nconst context = browser.contexts()[0];",
  "note": "The connecting playwright-core must match this server's major.minor version. …"
}
```

There is no `/pw/json/*`, because Firefox has no target list.

`404` when not running. `409` for a Chromium profile.

### `GET /api/profiles/:id/cdp/json/version`

Proxies Chrome's `/json/version` with `webSocketDebuggerUrl` rewritten. Also served with a
trailing slash, which Playwright requests.

`404` not running, `409` Camoufox, `502 {"detail":"CDP endpoint unreachable"}` if Chrome
does not answer within 5 s.

### `GET /api/profiles/:id/cdp/json/list`

Proxies the page target list with each `webSocketDebuggerUrl` rewritten. Also served as
`/cdp/json`, `/cdp/json/` and `/cdp/json/list/`. Same error codes as above.

### `GET /api/profiles/:id/cdp/alive`

Liveness for **both engines**, despite the path. It is the one `/cdp` route that works on
Camoufox.

```json
{ "alive": true }
```

| Engine | What it checks |
| --- | --- |
| `chromium` | DevTools answers `/json/version` |
| `camoufox` | The automation port accepts a TCP connection (a weaker signal; Firefox has no HTTP endpoint to ask) |

Returns `200` with `alive: true` or `false`, or `404 {"alive": false}` when not running.

Poll this after `launch`. `running` with `alive: false` means the session is wedged, so use
`force-stop` and launch again.

## Writing Camoufox scripts

Everything above the protocol, meaning the Playwright `Page` and `Locator` API, works as it
does on Chromium. For a scraper built on selectors and waits, usually only the connect line
changes. These are the exceptions.

### Your Playwright version must match

The server runs `playwright-core` `~1.60`. Install the same major.minor:

```bash
npm i playwright-core@~1.60.0
pip install "playwright~=1.60.0"
```

No `playwright install` is needed, because the browser lives in the container. `/api/status`
does not report this version; it is pinned in `server/package.json`.

**A mismatched client connects successfully and then fails on individual calls.** Playwright
normally rejects a mismatch with `HTTP 428`, but that check reads a user-agent this proxy
does not forward. With a 1.62 client and a 1.60 server, `title()`, `evaluate()`, `cookies()`
and `route()` worked, while `goto()`, `waitForSelector()`, `textContent()` and `screenshot()`
failed with:

```
page.goto: timeout: expected float, got undefined
```

That looks like a broken page or selector. If you see it, check your version first.

### Page globals

**This is the one thing that silently breaks scrapers ported from Chromium.**

`page.evaluate()` runs in an **isolated world**. It can use the DOM normally, but **globals
defined by the page come back `undefined`, with no error**:

```ts
await page.evaluate('window.__NEXT_DATA__');                     // undefined on Camoufox
await page.evaluate("document.querySelectorAll('.row').length"); // works
```

Three ways to read them:

```ts
// 1. Parse the script tag. Works on every engine and needs no configuration.
const data = JSON.parse((await page.locator('script#__NEXT_DATA__').textContent()) ?? '{}');

// 2. Capture the network response the data came from.
const [response] = await Promise.all([
  page.waitForResponse((r) => r.url().includes('/api/search')),
  page.click('button.search'),
]);
const results = await response.json();

// 3. Main-world eval. Requires engine_config.main_world_eval: true and a relaunch.
const state = await page.evaluate('mw:JSON.stringify(window.__NEXT_DATA__)');
```

Option 3 is detectable by the page, so use it only when needed. Without the setting it fails
loudly with `Main world evaluation is disabled`.

### What does not carry over

| Chromium feature | On Camoufox |
| --- | --- |
| `context.newCDPSession(page)` and raw CDP | Not available. Use the Playwright API. |
| `launch_args` and other command-line flags | Ignored. Configure through `engine_config`. |
| Stagehand `act()`, `extract()`, `observe()` | Not available. See below. |

Firefox is also stricter about clicking covered or off-screen elements, so prefer
`locator.click()` over clicking through `evaluate`.

### AI-driven automation

**Stagehand, browser-use, Skyvern, Puppeteer and Selenium cannot drive these profiles.**
They need CDP or Chromium, and nothing can provide CDP here.

These tools can, in principle, work with a Playwright Firefox endpoint. **None is a tested
configuration here, so try it before depending on it.**

| Option | Why it may work | Catch |
| --- | --- | --- |
| Midscene.js (TS) | Takes an arbitrary Playwright `Page` | Its docs warn Firefox may report errors; its CDP-based live view must be disabled |
| Notte (Python) | Calls `playwright.firefox.connect(url)` for `browser_type="firefox"` | Undocumented code path |
| Playwright MCP | Supports `browserName: 'firefox'` with a `remoteEndpoint` | Gives you tools, not an SDK |

Often the simplest route is to keep selectors for actions and send page text to a model for
extraction. That needs no browser integration:

```ts
const text = await page.locator('body').innerText();
// Send `text` plus your schema to any LLM, then validate the JSON it returns.
```

Both engines run side by side, so steps that truly need Stagehand can use a Chromium profile.

### Logged-in sessions

Cookies, `localStorage`, IndexedDB and saved logins survive stop and relaunch on both
engines. The usual pattern is to have a person sign in once through the
[live view](#live-view), solving any CAPTCHA or 2FA, and let every later run reuse the
session:

```ts
await page.goto('https://site.example/dashboard');
if (page.url().includes('/login')) {
  throw new Error('Session expired: sign in again through the live view.');
}
```

Avoid logging in from the script on every run. Repeated automated logins are a much stronger
detection signal than a long-lived session.

Leaving a profile running between runs also makes reconnecting much faster than relaunching.

## WebSocket endpoints

| Path | Purpose | Auth channels |
| --- | --- | --- |
| `/api/profiles/:id/vnc` | Live view stream | Bearer or cookie |
| `/api/profiles/:id/cdp` | Browser-level CDP | Bearer, cookie or `?token=` |
| `/api/profiles/:id/cdp/devtools/*` | Per-page CDP target | Bearer, cookie or `?token=` |
| `/api/profiles/:id/pw` | Playwright protocol (Camoufox) | `?token=` in practice |

A failed auth check returns HTTP `401` before the upgrade. The rest are reported as close
codes after the socket opens:

| Code | Meaning | What to do |
| --- | --- | --- |
| `4403` | `Origin` does not match `Host` | Browsers send `Origin`; connect from the same origin. Non-browser clients normally send none, which is allowed. |
| `4004` | Profile not found or not running | Launch it first |
| `4005` | Browser is not answering | The server has already stopped tracking the session, so launch again |
| `4006` | Wrong endpoint for this engine | `/cdp` on Camoufox or `/pw` on Chromium. Branch on `automation_protocol`. |

The automation proxies buffer anything a client sends while they check the browser, then
replay it, so clients can send commands immediately. Keepalive is handled for you: pings
go out every 20 s, and a peer that has not answered for 60 s (70 s for the live view) is
treated as gone.

## Live view

To hand a browser to a person, give them this URL. With auth on, they get a login page first.

```
<base-url>/#/p/<profile-id>/view
```

| Page | URL |
| --- | --- |
| Live view | `#/p/<id>/view` |
| Edit profile | `#/p/<id>/edit` |
| New profile | `#/new` |

The profile must be running for the live view to show anything. A profile created with
`headless: true` renders no window, so it has nothing to show.

`/api/profiles/:id/vnc` carries the stream, but it was built for the bundled noVNC 1.4
client, with a translation layer between that client and KasmVNC. Other VNC clients are
untested, and there is no VNC port to reach from outside. Use the web UI.

## Screenshots

### `GET /api/profiles/:id/screenshot`

Returns **raw JPEG bytes**, not JSON.

```bash
curl -H "Authorization: Bearer $AUTH_TOKEN" -o shot.jpg \
  localhost:8080/api/profiles/<id>/screenshot
```

| Header | Meaning |
| --- | --- |
| `Content-Type: image/jpeg` | Quality 55, sized to the page viewport |
| `Cache-Control: no-store` | |
| `X-Screenshot-Cached` | `false` means captured just now. `true` means the last saved image. |

It captures the **first open page**, which is not necessarily the tab in front. Use your
automation client for a specific tab or a full-page image.

**Check `X-Screenshot-Cached`.** A running profile also falls back to the old image if
capture fails or takes more than 5 s, so a response is not proof of the current state.

`404 {"detail":"Profile not found"}`, or `404 {"detail":"No screenshot available"}` if it has
never been captured.

## Clipboard

Both routes require a running profile, or return `404 {"detail":"Profile not running"}`.

### `POST /api/profiles/:id/clipboard`

Sets the profile's X clipboard, ready for a paste in the browser.

```json
{ "text": "hello" }
```

Maximum 1,048,576 characters, or `422`. Returns `{"ok": true}`.

### `GET /api/profiles/:id/clipboard`

```json
{ "text": "…" }
```

Returns what was **last copied inside a page**, on any open tab, and falls back to the X
clipboard only if there is none. So this **may not return what you just POSTed**. It returns
`""` if empty, and reads are capped at 1,048,576 characters.

The `clipboard_sync` profile field only controls the web viewer's relay. These routes work
regardless.

## Proxy testing

### `POST /api/proxy/test`

Sends a real request through the proxy to `api.ipify.org`, with a 10 s timeout.

```json
{ "proxy": "http://user:pass@host:8000" }
```

**Always returns `200`.** Check `ok`, not the status code:

```json
{ "ok": true, "exit_ip": "203.0.113.7", "latency_ms": 412, "error": null }
```

```json
{ "ok": false, "exit_ip": null, "latency_ms": null, "error": "Proxy URL missing port: http://host" }
```

`422` only if the request body itself is malformed. The tested proxy is not saved anywhere.

Validation error messages can echo the proxy URL, including its credentials, so do not write
`error` to shared logs unfiltered.

### Proxy formats

The same formats are accepted here and on a profile's `proxy` field:

| Format | Interpreted as |
| --- | --- |
| `http://user:pass@host:port` | As given |
| `https://…` or `socks5://…` | As given |
| `host:port` | `http://host:port` |
| `host:port:user:pass` | `http://user:pass@host:port` |

A port is required, and `:80` and `:443` are valid.

## System & binary

### `GET /api/status`

Health check. **Never requires auth.**

```json
{
  "running_count": 2,
  "binary_version": "146.0.7680.177.5",
  "camoufox_version": "152.0.4-beta.29",
  "profiles_total": 9
}
```

`binary_version` is the Chromium build the installed wrapper targets, which is not necessarily
what is on disk. `GET /api/binary` reports the build that will actually launch.
`camoufox_version` is `null` when Camoufox is not installed.

### `GET /api/binary`

The Chromium build and update state. See [`BinaryStatus`](#binarystatus).

### `GET /api/binary/camoufox`

```json
{
  "version": "152.0.4-beta.29",
  "installed": true,
  "platform": "lin.x86_64",
  "install_dir": "/opt/camoufox",
  "binary_path": "/opt/camoufox/camoufox-bin",
  "latest_version": "152.0.4-beta.29",
  "update_available": false
}
```

`latest_version` comes from GitHub and is cached for an hour, including failures. It is `null`
if the lookup fails. That means "unknown", not "up to date".

### `GET /api/binary/engines`

Both at once: `{ "chromium": <BinaryStatus>, "camoufox": <the object above> }`.

### `POST /api/binary/update`

**Chromium only.** Starts a background download and returns `202` immediately with the
`update` sub-object. Poll `GET /api/binary` for `update.state`: `running` → `done` or `error`.

`done` with `version: null` means it was already current. A new build applies on each
profile's next launch.

`409` when the install is not updatable from GitHub:

- **Pro** builds come from cloakbrowser.dev. Run `cloakbrowser update` in the container.
- **Override**: `CLOAKBROWSER_BINARY_PATH` is set, so the binary is yours to manage.

Camoufox has no update route. The ~630 MB archive is baked into the image, so update it by
rebuilding the image.

## MCP

`/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server over Streamable
HTTP, on the same port as everything else. It is stateless and replies with plain JSON. It
needs `Authorization: Bearer <token>` when auth is on; `?token=` is rejected.

### Connecting

Claude Code:

```bash
claude mcp add --transport http astrabrowser http://localhost:8080/mcp \
  --header "Authorization: Bearer your-secret-token"
```

Typical JSON client config:

```json
{
  "mcpServers": {
    "astrabrowser": {
      "type": "http",
      "url": "http://localhost:8080/mcp",
      "headers": { "Authorization": "Bearer your-secret-token" }
    }
  }
}
```

Raw calls must accept **both** response types, or they get `406`:

```bash
curl -X POST localhost:8080/mcp \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### Tools

| Tool | Inputs | Returns |
| --- | --- | --- |
| `list_profiles` | none | `ProfileResponse[]` |
| `get_profile` | `id` | `ProfileResponse` |
| `get_profile_status` | `id` | Status with an **absolute** `cdp_url` |
| `get_cdp_url` | `id` | `{ cdp_url, alive, usage }`, **absolute**. Fails if not running or on Camoufox. |
| `create_profile` | [`ProfileCreate`](#profilecreate) fields | `ProfileResponse` |
| `update_profile` | `id` + [`ProfileUpdate`](#profileupdate) fields | `ProfileResponse`. Only passed fields are written. |
| `delete_profile` | `id` | `{ ok, id }`. Stops, then removes the row, user-data dir and thumbnail. Irreversible. |
| `launch_profile` | `id`, `wait_for_cdp` (default `true`), `timeout_ms` (default `15000`) | See below |
| `stop_profile` | `id` | `{ ok, id }` |
| `force_stop_profile` | `id` | `{ ok, id }` |
| `take_screenshot` | `id` | An image block plus a text block saying live or cached |
| `test_proxy` | `proxy` | Same as `POST /api/proxy/test`. A dead proxy is `ok: false`, not an error. |

### `launch_profile`

```json
{
  "profile_id": "…",
  "status": "running",
  "engine": "chromium",
  "cdp_url": "http://host:8080/api/profiles/…/cdp",
  "cdp_ready": true,
  "vnc_ws_port": 6100,
  "display": ":100",
  "usage": "chromium.connectOverCDP('http://host:8080/api/profiles/…/cdp')"
}
```

- `cdp_ready` is `true` once the endpoint answers, `false` if `timeout_ms` passed first
  (**the browser is still launched**, so do not launch again), and `null` with
  `wait_for_cdp: false`.
- For Camoufox, `cdp_url` is `null` and a `note` replaces `usage`. **This is a successful
  launch, so do not retry it.**
- The URL carries no token. With auth on, append `?token=` or pass `headers`.

### What MCP means for Camoufox

MCP is designed to manage Camoufox profiles, not to drive them. Automate them over Playwright
using `automation_url` from `GET /api/profiles/:id`.

| Tools | Automation fields |
| --- | --- |
| `get_profile_status`, `launch_profile`, `get_cdp_url` | `cdp_url` only |
| `list_profiles`, `get_profile`, `create_profile`, `update_profile` | The full `ProfileResponse`, so also a **relative** `cdp_url`, `automation_url` and `automation_protocol` |

Treat the second row as incidental rather than as a supported MCP route to the Camoufox
endpoint.

### Errors

Expected failures, such as an unknown id, a profile that is not running or invalid inputs,
come back as tool results with `isError: true` and a readable message, not as JSON-RPC errors.
Read the message and act on it.

### Base URL

The absolute URLs come from `PUBLIC_BASE_URL` if set, otherwise from the request's scheme and
`Host`. Set it when the container is behind a reverse proxy that rewrites `Host`, or when
agents reach it under a different name than the one they connect to MCP with.

## Type reference

### ProfileCreate

Body of `POST /api/profiles` and input of `create_profile`. Only `name` is required.

Which engine reads each field is shown in the **Engine** column. The engines are kept apart on
purpose: the same control would mean different things on each.

| Field | Type | Default | Engine | Meaning |
| --- | --- | --- | --- | --- |
| `name` | string | required | Both | Display name; need not be unique |
| `engine` | `chromium` \| `camoufox` | `chromium` | Both | **Immutable after creation** |
| `engine_config` | object | `{}` | Camoufox | See [CamoufoxConfig](#camoufoxconfig) |
| `proxy` | string \| null | `null` | Both | See [proxy formats](#proxy-formats) |
| `timezone` | string \| null | `null` | Both | e.g. `America/New_York` |
| `locale` | string \| null | `null` | Both | e.g. `en-US` |
| `user_agent` | string \| null | `null` | Both | Overrides the generated UA. Usually better left unset, so it stays consistent with the rest of the fingerprint. |
| `screen_width` | int | `1920` | Both | Reported screen and display size |
| `screen_height` | int | `1080` | Both | Chromium's viewport is 133 px shorter, to allow for browser UI |
| `headless` | bool | `false` | Both | No window, so nothing in the live view |
| `color_scheme` | `light` \| `dark` \| `no-preference` \| null | `null` | Both | |
| `auto_launch` | bool | `false` | Both | Launch at manager start, one at a time, 60 s limit each |
| `clipboard_sync` | bool | `true` | Both | Web viewer clipboard relay only |
| `notes` | string \| null | `null` | Both | Free text |
| `tags` | `{tag, color?}[]` \| null | `null` | Both | `color` is a hex string. **Tag names must be unique within a profile.** |
| `fingerprint_seed` | int \| null | random | Chromium | Drives the synthetic device identity. Camoufox profiles get one but do not use it. |
| `platform` | `windows` \| `macos` \| `linux` | `windows` | Chromium | Reported OS |
| `gpu_vendor` | string \| null | `null` | Chromium | WebGL vendor override |
| `gpu_renderer` | string \| null | `null` | Chromium | WebGL renderer override |
| `hardware_concurrency` | int \| null | `null` | Chromium | Reported CPU count |
| `humanize` | bool | `false` | Chromium | See [the caveat for remote clients](#human-like-input-on-chromium) |
| `human_preset` | `default` \| `careful` | `default` | Chromium | |
| `geoip` | bool | `false` | Chromium | Derive geo and timezone from the exit IP |
| `launch_args` | string[] | `[]` | Chromium | Extra Chromium flags |

**A duplicate tag name returns a plain-text `500` and leaves partial state.** The profile row
is written first and is not rolled back. Keep tag names unique.

### CamoufoxConfig

`engine_config` for `engine: "camoufox"`. Every field is optional. It is validated at launch,
not at creation, and `engine_config` is ignored on Chromium profiles.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `os` | `windows` \| `macos` \| `linux` \| null | random | Spoofed OS; drives UA, fonts and GPU together. Set it if you want a stable identity. |
| `humanize` | bool \| number | `false` | Human-like cursor movement; a number caps its duration in seconds. Slows each action. |
| `geoip` | bool \| string | `false` | Derive geo, timezone, locale and WebRTC IP from the exit IP, or from the given IP. Turn this on with a proxy, because a UK proxy with a New York timezone is an obvious tell. |
| `block_images` | bool | `false` | Saves bandwidth |
| `block_webrtc` | bool | `false` | |
| `block_webgl` | bool | `false` | Rarely wanted: a missing WebGL context is itself a bot signal |
| `enable_cache` | bool | `false` | |
| `disable_coop` | bool | `false` | |
| `main_world_eval` | bool | `false` | Allows `page.evaluate("mw:…")`. Detectable by the page. |
| `fingerprint_preset` | bool | `true` | Use a bundled real-device fingerprint |
| `webgl_vendor` / `webgl_renderer` | string \| null | `null` | Must be set together, or both are ignored |
| `fonts` | string[] | `[]` | |
| `exclude_default_addons` | bool | `false` | Drops the bundled uBlock Origin |
| `config` | object | `{}` | Raw `CAMOU_CONFIG` overrides, e.g. `{"webrtc:ipv4": "1.2.3.4"}`. An escape hatch that wins over other settings; prefer the fields above. |

### ProfileUpdate

Body of `PUT /api/profiles/:id`. Every `ProfileCreate` field except `engine` is optional.
`id`, `user_data_dir`, `created_at` and `updated_at` cannot be set either.

| You send | Result |
| --- | --- |
| Key omitted | Unchanged |
| `null` on an optional text or number field | Cleared |
| `null` on `platform`, `screen_*`, `human_preset`, or a boolean | Reads back as its default |
| `launch_args: null` / `engine_config: null` | Reset to `[]` / `{}` |
| `tags: []` | Removes all tags |
| `tags: null` | **Unchanged** |
| `tags: [...]` | Replaces all tags |
| `engine_config: {...}` | **Replaces the whole object; it is not merged.** Send every key you want to keep. |
| `name: null` | `422` |
| `fingerprint_seed: null` | Plain-text `500`. Omit the key instead. |

### ProfileResponse

Every stored field as above, plus:

| Field | Type | |
| --- | --- | --- |
| `id` | string | UUID |
| `user_data_dir` | string | Session directory inside the container |
| `created_at` / `updated_at` | string | ISO 8601 |
| `tags` | `{tag, color}[]` | Always an array; `color` may be `null` |
| `status` | `running` \| `stopped` | |
| `vnc_ws_port` | int \| null | Internal only |
| `cdp_url` | string \| null | Relative path when running on `chromium`; **always `null` on `camoufox`** |
| `automation_url` | string \| null | Relative path when running, on either engine |
| `automation_protocol` | `cdp` \| `playwright-firefox` \| null | What `automation_url` speaks |

`engine_config` is returned as stored, including any unrecognized keys. Defaults are not
filled in.

### LaunchResponse

`{ profile_id, status: "running", engine, vnc_ws_port, display, cdp_url, automation_url,
automation_protocol }`

### ProfileStatusResponse

`{ status, engine, vnc_ws_port, display, cdp_url, automation_url, automation_protocol }`. All
but `status` are `null` when stopped.

### ProxyTestResponse

`{ ok, exit_ip, latency_ms, error }`

### ProfileImportResponse

`{ created, skipped: [{name, reason}], renamed: [{from, to}] }`

### ProfileExport

```json
{
  "version": 1,
  "exported_at": "2026-01-01T00:00:00.000Z",
  "profiles": [ /* stored fields, minus id, user_data_dir, created_at, updated_at */ ]
}
```

`version` increases when the shape of `profiles[]` changes.

### BinaryStatus

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | string \| null | The version that will actually launch. `null` under an override, or if none resolves. |
| `bundled_version` | string | What the installed wrapper was built against |
| `tier` | `free` \| `pro` \| `override` | |
| `installed` | bool | |
| `platform` | string | |
| `binary_path` | string \| null | |
| `latest_version` | string \| null | Newest published release for this platform; `null` if unknown or not updatable |
| `update_available` | bool | |
| `updatable` | bool | `false` for `pro` and `override` |
| `update` | `{state, version, error}` | `state`: `idle` \| `running` \| `done` \| `error` |

## Deployment settings that affect clients

| Variable | Default | Effect |
| --- | --- | --- |
| `AUTH_TOKEN` | unset | Enables auth. Unset means every route is open. |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Where the server listens inside the container |
| `PUBLIC_BASE_URL` | derived per request | Base of the absolute URLs from MCP |
| `CLOAKBROWSER_DATA_DIR` | `/data` | Persistent data; on Railway, falls back to `RAILWAY_VOLUME_MOUNT_PATH` first |
| `LOG_LEVEL` | `INFO` | `DEBUG` for diagnosis |
| `CLOAKBROWSER_LICENSE_KEY` | unset | Selects the Pro Chromium build |
| `CLOAKBROWSER_VERSION` | unset | Pins a Chromium build |
| `CLOAKBROWSER_AUTO_UPDATE` | `true` | Whether the Chromium binary self-updates |
| `CLOAKBROWSER_BINARY_PATH` | unset | Use your own Chromium binary |
| `CAMOUFOX_INSTALL_DIR` | `/opt/camoufox` in the image | Where Camoufox is installed |
| `CAMOUFOX_BINARY_PATH` | unset | Swaps the Camoufox executable only; the managed install is still required |

The `CLOAKBROWSER_` prefix is intentional. It names the upstream engine.

Capacity: budget about 512 MB of RAM per running profile. The server allows up to 100
concurrent automation ports. Run the container with `--shm-size=1g`, or Chromium crashes on
image-heavy pages.

Persistent data layout: `profiles.db`, `profiles/<id>/` (browser data), `thumbs/<id>.jpg` and
`fonts/`. Without a mounted volume, all of it is lost when the container is replaced.

Behind a reverse proxy, forward WebSocket upgrades and set `x-forwarded-proto`, which decides
`wss` URLs and the cookie's `Secure` flag. Use HTTPS beyond localhost, because the token
otherwise travels in clear text.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `timeout: expected float, got undefined` on Camoufox | Playwright version mismatch. [Match the server's version.](#your-playwright-version-must-match) |
| `CDP connections are only supported by Chromium` | `connectOverCDP` on a Camoufox profile. Use `firefox.connect`. |
| `CDP session is only available in Chromium` | `newCDPSession` on Camoufox. Use the Playwright API. |
| `window.__X__` is `undefined` on Camoufox | Isolated world. See [page globals](#page-globals). |
| `Main world evaluation is disabled` | Set `engine_config.main_world_eval: true` and relaunch. |
| Connected but no cookies or logins | You used `newContext()`. Use `browser.contexts()[0]`. |
| `browser.contexts()` is empty | The profile was not fully up. Check `/cdp/alive` and retry. |
| `cdp_url` is `null` on a running profile | Expected on Camoufox. Use `automation_url`. |
| Profile stopped when a script ended | Puppeteer's `browser.close()` shuts the browser down. Use `disconnect()`. |
| Settings did not change after `PUT` | They apply on the next launch. Stop and relaunch. |
| A setting has no effect | It may belong to the other engine, or be misspelled and dropped. Check the [Engine column](#profilecreate). |
| `engine_config` key was lost after `PUT` | It replaces the whole object. Send every key. |
| Launch returns `400` | Bad `proxy`. Check it with `POST /api/proxy/test`. |
| Launch returns `500` | Check `engine_config`, then the server log, or call MCP `launch_profile` for the real message. |
| `running` but connections hang | Wedged. `force-stop`, then launch again. |
| WebSocket `401` before opening | Missing token. `/cdp` and `/pw` accept `?token=`; `/vnc` does not. |
| WebSocket close `4004` / `4005` / `4006` / `4403` | See [the close codes](#websocket-endpoints). |
| CDP URL connects to the wrong host | A proxy rewrites `Host`. Set `PUBLIC_BASE_URL` for MCP and pass a direct `wss://` URL to the client. |
| `406` from `/mcp` | Send `Accept: application/json, text/event-stream`. |
| `401` from `/mcp` with `?token=` | MCP takes the Bearer header only. |
| Screenshot looks stale | Check `X-Screenshot-Cached`. Live capture may have failed. |
| `update_available` is `false` and `latest_version` is `null` | GitHub lookup failed or was rate-limited. The state is unknown. |
| Profiles vanished after a redeploy | No volume was mounted on the data directory. |
