# API Reference

AstraBrowser Manager exposes a REST control plane, three WebSocket proxies, and an
MCP tool surface — all on the same port as the web UI (`8080` by default).

MCP is the **control plane**: create, launch, stop and inspect profiles of either
engine. Chromium profiles can also be *driven* from here, over the `cdp_url` these
tools return.

Camoufox profiles can be managed here but **not driven** — they have no CDP endpoint,
and MCP does not hand out their Playwright endpoint. Automate them over Playwright
outside MCP, reading `automation_url` from the REST API; see
[CAMOUFOX.md](CAMOUFOX.md). MCP responses therefore carry `cdp_url` only, never
`automation_url` / `automation_protocol` — those are REST fields.

- [Conventions](#conventions)
- [Authentication](#authentication)
- [Profiles](#profiles)
- [Export & import](#export--import)
- [Launch & stop](#launch--stop)
- [Automation](#automation)
- [WebSocket endpoints](#websocket-endpoints)
- [Screenshots](#screenshots)
- [Clipboard](#clipboard)
- [Proxy testing](#proxy-testing)
- [System & binary](#system--binary)
- [MCP](#mcp)
- [Type reference](#type-reference)

## Conventions

| | |
| --- | --- |
| Base URL | `http://localhost:8080` (whatever host the container is published on) |
| Prefix | Every REST route lives under `/api`. MCP is at `/mcp`. |
| Content type | JSON in, JSON out — except screenshots, which return `image/jpeg`. |
| Field naming | `snake_case` throughout. The React frontend consumes these shapes directly, so the names are a wire contract, not a style choice. |
| Errors | `{ "detail": "<message>" }` |
| Validation errors | `422` with `{ "detail": [ ...Zod issues... ] }` |

IDs are UUID strings assigned at creation.

## Authentication

Authentication is **off by default**. Set the `AUTH_TOKEN` environment variable to
turn it on; every `/api/*` route and `/mcp` then requires the token.

Three channels are accepted:

| Channel | Where | Notes |
| --- | --- | --- |
| `Authorization: Bearer <token>` | Any guarded route | The normal choice for API clients. |
| `auth_token` cookie | Any guarded route | Set by `POST /api/auth/login`; used by the web UI. |
| `?token=<token>` | **Automation routes only** | See below. |

The query parameter is deliberately narrow — it works only on
`/api/profiles/<id>/cdp` and `/api/profiles/<id>/pw` and below. Tokens in URLs leak
into access logs, referrers, and error traces in a way headers do not, so it is not
accepted on `/api/profiles` itself, nor on `/mcp`. It exists because not every client
can send a header: Playwright's `connectOverCDP` takes a `headers` option, but
Stagehand exposes only `localBrowserLaunchOptions.cdpUrl`, a bare URL string — and
`firefox.connect()` takes no headers option at all, so for Camoufox the query
parameter is the only channel there is.

Three routes bypass auth entirely, so the login page and the Docker healthcheck work:
`/api/auth/status`, `/api/auth/login`, `/api/status`.

Token comparison is constant-time. Anything else guarded returns `401`
`{"detail":"Unauthorized"}`.

### `GET /api/auth/status`

Whether auth is enabled, and whether this request is already authenticated. Never
requires auth.

```json
{ "auth_required": true, "authenticated": false }
```

### `POST /api/auth/login`

```json
{ "token": "your-token" }
```

On success sets the `auth_token` cookie (`httpOnly`, `SameSite=Strict`, `Secure` when
the original request was HTTPS) and returns `{"ok": true}`. Wrong or malformed token →
`401 {"detail":"Invalid token"}`. When `AUTH_TOKEN` is unset this is a no-op returning
`{"ok": true}`.

### `POST /api/auth/logout`

Clears the cookie. `{"ok": true}`.

## Profiles

### `GET /api/profiles`

Every profile, each merged with its live status. Returns an array of
[`ProfileResponse`](#profileresponse).

```bash
curl -H "Authorization: Bearer $AUTH_TOKEN" localhost:8080/api/profiles
```

`automation_url` is the endpoint for a running profile and `null` for a stopped one.
`cdp_url` is the same value for Chromium profiles and **always `null` for Camoufox**,
which has no CDP. Both are **relative paths** — see [Automation](#automation).

### `POST /api/profiles`

Create a profile. Only `name` is required; every other field has a default or is
generated. See [`ProfileCreate`](#profilecreate).

```bash
curl -X POST localhost:8080/api/profiles \
  -H 'Content-Type: application/json' \
  -d '{"name":"scraper-01","proxy":"http://user:pass@host:8000","timezone":"America/New_York"}'
```

`201` with the created [`ProfileResponse`](#profileresponse), or `422` on validation
failure. Creating does not launch the browser.

Leave `fingerprint_seed` unset unless you have a reason: a random seed is generated
per profile, and reusing one seed across profiles makes them look like the same
machine.

### `GET /api/profiles/:id`

One [`ProfileResponse`](#profileresponse). `404` if unknown.

### `PUT /api/profiles/:id`

Partial update. **Only keys actually present in the request body are written** — an
omitted key is left alone, it is not nulled. See
[`ProfileUpdate`](#profileupdate). Changes take effect on the next launch.

Returns the updated [`ProfileResponse`](#profileresponse); `404` unknown, `422`
invalid.

### `DELETE /api/profiles/:id`

Stops the browser if running, then permanently removes the database row, the
user-data directory (cookies, localStorage, logins), and the cached thumbnail.

`{"ok": true}`, or `404`. This cannot be undone.

## Export & import

Route order matters here: `export` and `import` are registered before `/:id`, so they
are never read as profile ids.

### `GET /api/profiles/export`

All profiles as a portable JSON envelope, with
`Content-Disposition: attachment; filename="astrabrowser-profiles.json"`. Install-specific
fields (`id`, `user_data_dir`, `created_at`, `updated_at`) are stripped. See
[`ProfileExport`](#profileexport).

### `GET /api/profiles/:id/export`

The same envelope for a single profile, filename slugified from its name
(`"My Profile!"` → `my-profile.json`). `404` if unknown.

### `POST /api/profiles/import`

Accepts either the full envelope or a bare array of profile objects, so a
hand-trimmed file still imports.

One bad entry never aborts the batch. Names that collide with an existing profile are
renamed rather than shadowed — `Name` → `Name (imported)` → `Name (imported 2)`.

```json
{
  "created": 3,
  "skipped": [{ "name": "broken", "reason": "..." }],
  "renamed": [{ "from": "scraper-01", "to": "scraper-01 (imported)" }]
}
```

`422` if the payload does not parse.

## Launch & stop

### `POST /api/profiles/:id/launch`

No request body. Starts Xvnc and the stealth-Chromium instance for this profile.

```json
{
  "profile_id": "…",
  "status": "running",
  "vnc_ws_port": 5901,
  "display": ":1",
  "cdp_url": "/api/profiles/…/cdp"
}
```

| Code | Meaning |
| --- | --- |
| `200` | Launched |
| `404` | `Profile not found` |
| `409` | `Profile is already running` |
| `400` | Bad configuration — invalid proxy, unusable `fingerprint_seed`. The message is safe to show a user. |
| `500` | `Failed to launch browser` (server-side failure; check logs) |

**This returns before Chrome's DevTools endpoint is necessarily accepting
connections.** `mgr.launch()` resolves once Playwright has a BrowserContext, which is
slightly earlier. REST clients that connect immediately should poll
[`/cdp/alive`](#get-apiprofilesidcdpalive) first. The MCP `launch_profile` tool does
this waiting for you (`wait_for_cdp`, default `true`).

Requires the CloakBrowser binary and an X server, so it only works inside the Docker
image.

### `POST /api/profiles/:id/stop`

Graceful stop: closes the browser context and tears down the display. The user-data
directory is kept, so cookies and logins survive until the next launch.

`{"ok": true}`, or `404 {"detail":"Profile is not running"}`.

### `POST /api/profiles/:id/force-stop`

Escape hatch for a wedged session: drops the tracking entry and tears down Xvnc
**without waiting on the browser**. Use it when `stop` hangs, or when a profile
reports `running` but its CDP endpoint is dead (`alive: false`).

`{"ok": true}`, or `404 {"detail":"Profile is not running"}`.

### `GET /api/profiles/:id/status`

Liveness only — cheaper than fetching the whole profile.

```json
{ "status": "running", "vnc_ws_port": 5901, "display": ":1", "cdp_url": "/api/profiles/…/cdp" }
```

Stopped profiles return `"stopped"` with `null` for the other three. `404` if the
profile does not exist.

## Automation

Every running profile exposes an automation endpoint, proxied through this server.
The same session is visible in VNC and drivable at the same time.

**The protocol depends on the engine, so branch on `automation_protocol`:**

| `engine` | `automation_protocol` | Endpoint | Connect with |
| --- | --- | --- | --- |
| `chromium` | `cdp` | `/api/profiles/<id>/cdp` | `chromium.connectOverCDP(url)` |
| `camoufox` | `playwright-firefox` | `/api/profiles/<id>/pw` | `firefox.connect(wsUrl)` |

Camoufox is Firefox-based and has **no CDP endpoint at all** — Firefox removed its
CDP implementation in version 141, and Playwright throws
`CDP connections are only supported by Chromium` if you try. `cdp_url` is therefore
always `null` for a Camoufox profile, and the CDP routes return `409` for one. Read
`automation_url` instead; it is populated for both engines.

For writing and running Camoufox scripts — client setup, the isolated-world gotcha,
worked scrapers, migrating off Stagehand — see **[CAMOUFOX.md](CAMOUFOX.md)**.

`cdp_url` is unchanged for Chromium profiles, so existing CDP clients need no edits.

### Chromium (CDP)

```javascript
const { chromium } = require("playwright");

const browser = await chromium.connectOverCDP(
  "http://localhost:8080/api/profiles/<profile-id>/cdp",
);
const page = browser.contexts()[0].pages()[0];
await page.goto("https://example.com");
```

```python
from playwright.async_api import async_playwright

async with async_playwright() as pw:
    browser = await pw.chromium.connect_over_cdp(
        "http://localhost:8080/api/profiles/<profile-id>/cdp"
    )
    page = browser.contexts[0].pages[0]
    await page.goto("https://example.com")
```

### Camoufox (Playwright protocol)

`firefox.connect()` takes a **`ws://` URL**, unlike `connectOverCDP()` which takes an
`http://` base and discovers the socket itself.

`browser.contexts()[0]` is the profile's persistent context — the same window shown in
the live view, with its cookies and logins on disk. Do **not** call `newContext()`:
that would create a throwaway context and lose the profile's identity, which is the
whole point of the profile.

```javascript
const { firefox } = require("playwright");

const browser = await firefox.connect(
  "ws://localhost:8080/api/profiles/<profile-id>/pw",
);
const context = browser.contexts()[0];
const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://example.com");
```

```python
from playwright.async_api import async_playwright

async with async_playwright() as pw:
    browser = await pw.firefox.connect(
        "ws://localhost:8080/api/profiles/<profile-id>/pw"
    )
    context = browser.contexts[0]
    page = context.pages[0] if context.pages else await context.new_page()
    await page.goto("https://example.com")
```

Two constraints that do not apply to CDP:

- **Client version lock.** Your `playwright` / `playwright-core` major.minor must
  match this server's — but **the mismatch is not reported**. Playwright's own
  `HTTP 428` guard reads the `Playwright/x.y.z` user-agent on the upgrade, and this
  server proxies the socket, opening its upstream connection without that header. A
  mismatched client therefore connects, and then fails on individual calls with
  `timeout: expected float, got undefined` (verified: 1.62 client, 1.60 server).
  `GET /api/status` does not report the version; check `server/package.json`.
- **No target list.** Firefox exposes no `/json/version` or `/json/list`, so the CDP
  discovery endpoints below are Chromium-only.

Closing the browser handle from a client does **not** stop the profile — the server
owns the session lifecycle, and `POST /api/profiles/<id>/stop` is what ends it.

With auth enabled, append `?token=<AUTH_TOKEN>` (accepted on both `/cdp` and `/pw`).

### Absolute vs relative URLs

REST responses return `cdp_url` as a **relative path** (`/api/profiles/<id>/cdp`).
This is deliberate — the frontend is same-origin. Out-of-process clients must prefix
their own scheme and host.

MCP clients are handed the **absolute** URL instead, built from `PUBLIC_BASE_URL` if
set, otherwise from the request's scheme and `Host` header.

### How the WebSocket URLs are rewritten

Chrome reports its debugger URLs as `ws://127.0.0.1:<internal-port>/devtools/...`,
which is unreachable from outside the container. The discovery endpoints rewrite them
to point back at this server:

```
ws(s)://<host>/api/profiles/<id>/cdp[?token=…]                      # browser target
ws(s)://<host>/api/profiles/<id>/cdp/devtools/<suffix>[?token=…]    # page target
```

`<host>` comes from the request's `Host` header; the scheme is `wss` when
`x-forwarded-proto` contains `https`. The `?token=` is echoed **only when the caller
already sent one as a query parameter** — clients authenticating by header or cookie
get a bare URL, so the secret is never baked into a URL they did not choose to put it
in.

### `GET /api/profiles/:id/cdp`

Chromium profiles only. Without an `Upgrade: websocket` header, returns a descriptor:

```json
{
  "cdp_url": "/api/profiles/…/cdp",
  "automation_url": "/api/profiles/…/cdp",
  "automation_protocol": "cdp",
  "usage": "playwright.chromium.connect_over_cdp('http://<host>/api/profiles/…/cdp')"
}
```

With the upgrade header, the same path becomes the browser-level CDP WebSocket
proxy — one path, two behaviors.

`404 {"detail":"Profile not running"}` when stopped.
`409` when the profile runs Camoufox, which has no CDP; use `/pw`.

### `GET /api/profiles/:id/pw`

Camoufox profiles only. The Playwright-protocol counterpart of `/cdp`, with the same
upgrade hand-off: a descriptor over plain HTTP, the WebSocket proxy on upgrade.

```json
{
  "automation_url": "/api/profiles/…/pw",
  "automation_protocol": "playwright-firefox",
  "usage": "const browser = await firefox.connect('ws://<host>/api/profiles/…/pw');\nconst context = browser.contexts()[0];",
  "note": "The connecting playwright-core must match this server's major.minor version, or the upgrade is rejected with HTTP 428."
}
```

There is no `/pw/json/*` — Firefox exposes no target list. Clients connect straight to
this URL.

`404` when stopped, `409` when the profile runs Chromium.

### `GET /api/profiles/:id/cdp/json/version`

Proxies Chrome's `/json/version`, with `webSocketDebuggerUrl` rewritten. Also served
with a trailing slash, because Playwright probes several spellings.

`404` not running, `502 {"detail":"CDP endpoint unreachable"}` if Chrome does not
answer within 5 s.

### `GET /api/profiles/:id/cdp/json/list`

Proxies `/json/list` — the page targets — with every `webSocketDebuggerUrl` rewritten.
Also served as `/cdp/json`, `/cdp/json/`, and `/cdp/json/list/`.

Same error codes as above.

### `GET /api/profiles/:id/cdp/alive`

Is Chrome's debugger actually answering?

```json
{ "alive": true }
```

`404 {"alive": false}` when the profile is not running. Poll this after `launch` before
connecting, and use it to detect a wedged session worth `force-stop`ping.

## WebSocket endpoints

Three routes upgrade instead of returning JSON.

| Path | Purpose |
| --- | --- |
| `GET /api/profiles/:id/vnc` | noVNC stream of the profile's display |
| `GET /api/profiles/:id/cdp` | Browser-level CDP |
| `GET /api/profiles/:id/cdp/devtools/*` | Per-page CDP target |

All three check the `Origin` header against `Host` when an origin is present
(non-browser clients that send no `Origin` are allowed through). Close codes:

| Code | Meaning |
| --- | --- |
| `4403` | Origin/Host mismatch |
| `4004` | Profile not found or not running |
| `4005` | CDP not available — Chrome is not answering |

The CDP proxy buffers anything the client sends while it probes Chrome and replays it
once connected, because Playwright fires its first commands the instant the socket
opens. If the probe fails, the stale registry entry is evicted and the socket closes
`4005` rather than hanging. The proxy pings every 20 s and gives up on a missing pong
after 60 s.

## Screenshots

### `GET /api/profiles/:id/screenshot`

Returns **raw JPEG bytes**, not JSON.

| Header | Meaning |
| --- | --- |
| `Content-Type: image/jpeg` | |
| `Cache-Control: no-store` | A thumbnail's whole value is being current |
| `X-Screenshot-Cached: true\|false` | `true` = last-seen image from when the profile last ran; `false` = live capture |

`404 {"detail":"Profile not found"}`, or `404 {"detail":"No screenshot available"}` if
the profile has never been captured.

## Clipboard

Both routes require the profile to be running (`404 {"detail":"Profile not running"}`).

### `POST /api/profiles/:id/clipboard`

Push text into the profile's X clipboard.

```json
{ "text": "hello" }
```

Max 1 MiB; `422` beyond that. Returns `{"ok": true}`.

### `GET /api/profiles/:id/clipboard`

Read it back: `{ "text": "…" }`.

## Proxy testing

### `POST /api/proxy/test`

Check a proxy before assigning it to a profile.

```json
{ "proxy": "http://user:pass@host:8000" }
```

**Always returns `200`.** A proxy that does not work is a successful test with a
negative result, not a failed request:

```json
{ "ok": true, "exit_ip": "203.0.113.7", "latency_ms": 412, "error": null }
{ "ok": false, "exit_ip": null, "latency_ms": null, "error": "Invalid proxy: missing port" }
```

`422` only if the body itself is malformed.

## System & binary

### `GET /api/status`

Health check. **Never requires auth** — the Docker healthcheck uses it.

```json
{
  "running_count": 2,
  "binary_version": "141.0.7390.65",
  "camoufox_version": "152.0.4-beta.29",
  "profiles_total": 9
}
```

`binary_version` is the stealth-Chromium build and keeps its name for compatibility.
`camoufox_version` is `null` when Camoufox is not installed.

### `GET /api/binary`

Installed stealth-Chromium build and whether an update is available. See
[`BinaryStatus`](#binarystatus). Shape unchanged — this route is Chromium-only.

### `GET /api/binary/camoufox`

The Camoufox equivalent:

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

There is no `POST /api/binary/camoufox/update`. The archive is ~630 MB and is baked
into the image at build time; pulling that into a running container's writable layer
from an HTTP request is not something to trigger casually. Rebuild the image instead.

### `GET /api/binary/engines`

Both of the above at once, keyed by engine: `{ "chromium": …, "camoufox": … }`.

### `POST /api/binary/update`

Starts a background download of the newest published build and returns `202`
immediately with the update sub-object. Poll `GET /api/binary` for progress
(`update.state`: `idle` → `running` → `done` | `error`).

`409` when the install is not updatable from GitHub:

- **Pro** builds come from cloakbrowser.dev with a licence key — run
  `cloakbrowser update` in the container instead.
- **Override** — `CLOAKBROWSER_BINARY_PATH` is set, so the binary is yours to manage.

## MCP

`ALL /mcp` — a [Model Context Protocol](https://modelcontextprotocol.io) server over
the Streamable HTTP transport, stateless, on the same port as the UI. It is guarded by
`AUTH_TOKEN` like any `/api` route, and does **not** accept `?token=`.

Twelve tools cover the control plane. Page-level automation is deliberately absent:
the agent gets a CDP URL and drives the browser with its own Playwright or Puppeteer
client, which is far cheaper and more capable than routing every click through a model.

| Tool | Inputs | Notes |
| --- | --- | --- |
| `list_profiles` | — | Same shape as `GET /api/profiles`, including the **relative** `cdp_url` |
| `get_profile` | `id` | Full config + status |
| `get_profile_status` | `id` | Liveness; **absolute** `cdp_url` |
| `get_cdp_url` | `id` | `{cdp_url, alive, usage}`; **absolute**. Fails if not running, or if the profile runs Camoufox (no CDP endpoint exists) |
| `create_profile` | `ProfileCreate` fields | |
| `update_profile` | `id` + `ProfileUpdate` fields | Only passed fields are written |
| `delete_profile` | `id` | Stops, then removes row + user-data dir + thumbnail |
| `launch_profile` | `id`, `wait_for_cdp` (default `true`), `timeout_ms` (default `15000`) | Returns **absolute** `cdp_url` plus `cdp_ready` |
| `stop_profile` | `id` | |
| `force_stop_profile` | `id` | Wedged-session escape hatch |
| `take_screenshot` | `id` | JPEG; live if running, else last cached |
| `test_proxy` | `proxy` | Never throws |

Expected failures (no such profile, not running) come back as tool errors with a
readable message, not JSON-RPC protocol errors, so the model can act on them.

Set `PUBLIC_BASE_URL` when the container sits behind a reverse proxy that rewrites
`Host`, or is reached over a different scheme — the CDP URLs handed to agents are
built from it.

## Type reference

### ProfileCreate

Body of `POST /api/profiles`. Only `name` is required.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | — | Display name |
| `engine` | `chromium` \| `camoufox` | `chromium` | Browser engine. **Immutable after creation** — the user-data dir is written in the engine's own format. |
| `engine_config` | object | `{}` | Engine-specific settings; see [CamoufoxConfig](#camoufoxconfig). Ignored for `chromium`. |
| `fingerprint_seed` | int \| null | random | Drives the whole synthetic device identity |
| `proxy` | string \| null | `null` | `http://user:pass@host:port` |
| `timezone` | string \| null | `null` | e.g. `America/New_York` |
| `locale` | string \| null | `null` | e.g. `en-US` |
| `platform` | `windows` \| `macos` \| `linux` | `windows` | Reported OS |
| `user_agent` | string \| null | `null` | Override the generated UA |
| `screen_width` | int | `1920` | |
| `screen_height` | int | `1080` | |
| `gpu_vendor` | string \| null | `null` | WebGL vendor override |
| `gpu_renderer` | string \| null | `null` | WebGL renderer override |
| `hardware_concurrency` | int \| null | `null` | Reported CPU count |
| `humanize` | bool | `false` | Human-like input timing |
| `human_preset` | `default` \| `careful` | `default` | |
| `headless` | bool | `false` | |
| `geoip` | bool | `false` | Derive geo/timezone from the proxy's exit IP |
| `clipboard_sync` | bool | `true` | |
| `auto_launch` | bool | `false` | Launch on manager start |
| `color_scheme` | `light` \| `dark` \| `no-preference` \| null | `null` | |
| `launch_args` | string[] | `[]` | Extra Chromium flags |
| `notes` | string \| null | `null` | |
| `tags` | `{tag, color?}[]` \| null | `null` | `color` is a hex string |

The rows from `platform` down to `launch_args` are **Chromium-only**. A Camoufox
profile ignores them and takes its fingerprint from `engine_config` instead; the two
are kept separate on purpose, so changing one engine's settings cannot affect the
other.

### CamoufoxConfig

`engine_config` for `engine: "camoufox"`. Every field is optional.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `os` | `windows` \| `macos` \| `linux` \| null | random | Spoofed OS; drives UA, fonts and GPU together |
| `humanize` | bool \| number | `false` | Human-like cursor movement; a number caps its duration in seconds |
| `geoip` | bool \| string | `false` | Derive geo/timezone/locale and the WebRTC IP from the exit IP, or from a given IP |
| `block_images` | bool | `false` | |
| `block_webrtc` | bool | `false` | |
| `block_webgl` | bool | `false` | Note that a missing WebGL context is itself a bot signal |
| `enable_cache` | bool | `false` | |
| `disable_coop` | bool | `false` | |
| `main_world_eval` | bool | `false` | Allows `page.evaluate("mw:…")` to mutate the DOM. Detectable by the page |
| `fingerprint_preset` | bool | `true` | Use a bundled real-device fingerprint |
| `webgl_vendor` / `webgl_renderer` | string \| null | `null` | Must be set together |
| `fonts` | string[] | `[]` | |
| `exclude_default_addons` | bool | `false` | Drops the bundled uBlock Origin |
| `config` | object | `{}` | Raw `CAMOU_CONFIG` property overrides, e.g. `{"webrtc:ipv4": "1.2.3.4"}` |

### ProfileUpdate

Body of `PUT /api/profiles/:id`. Every field above is optional and nullable; `id`,
`engine`, `user_data_dir`, `created_at`, and `updated_at` cannot be set. Omitted keys
are left untouched. `engine_config` is replaced wholesale, not merged.

### ProfileResponse

Every `ProfileCreate` field as stored, plus:

| Field | Type | |
| --- | --- | --- |
| `id` | string | UUID |
| `user_data_dir` | string | On-disk session directory |
| `created_at` / `updated_at` | string | ISO 8601 |
| `tags` | `{tag, color}[]` | |
| `status` | `running` \| `stopped` | |
| `vnc_ws_port` | int \| null | |
| `cdp_url` | string \| null | Relative path when running on `chromium`; **always `null` for `camoufox`** |
| `automation_url` | string \| null | Relative path when running, for either engine |
| `automation_protocol` | `cdp` \| `playwright-firefox` \| null | Which protocol `automation_url` speaks |

### LaunchResponse

`{ profile_id, status: "running", engine, vnc_ws_port, display, cdp_url,
automation_url, automation_protocol }`

### ProfileStatusResponse

`{ status, engine, vnc_ws_port, display, cdp_url, automation_url,
automation_protocol }` — all but `status` are `null` when stopped.

### ProxyTestResponse

`{ ok, exit_ip, latency_ms, error }`

### ProfileImportResponse

`{ created, skipped: [{name, reason}], renamed: [{from, to}] }`

### ProfileExport

```json
{
  "version": 1,
  "exported_at": "2026-01-01T00:00:00.000Z",
  "profiles": [ /* ProfileCreate-shaped entries, minus install-specific fields */ ]
}
```

`version` bumps when the shape of `profiles[]` changes.

### BinaryStatus

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | string \| null | The version that will actually launch |
| `bundled_version` | string | What the installed wrapper was built against |
| `tier` | `free` \| `pro` \| `override` | |
| `installed` | bool | |
| `platform` | string | |
| `binary_path` | string \| null | |
| `latest_version` | string \| null | Newest published release for this platform |
| `update_available` | bool | |
| `updatable` | bool | False for `pro` and `override` installs |
| `update` | `{state, version, error}` | `state`: `idle` \| `running` \| `done` \| `error` |
