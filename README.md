<h1 align="center">AstraBrowser Manager</h1>

Each profile is an isolated stealth-Chromium instance with its own fingerprint, proxy, cookies, and session data. Profiles persist across restarts. Everything runs in one Docker container.

```bash
docker run -d --name astrabrowser-manager \
  -p 127.0.0.1:8080:8080 \
  -v ~/.astrabrowser-manager:/data \
  --shm-size=1g \
  --restart unless-stopped \
  ghcr.io/sahilmahadwar/astra-browser-manager:latest
```

Open [http://localhost:8080](http://localhost:8080) in your browser. Create a profile. Click Launch. Done.

See [Run with Docker](#run-with-docker) for the flags, environment variables, and
available image tags.

### Build from source instead

```bash
git clone https://github.com/SahilMahadwar/AstraBrowser-Manager.git
cd AstraBrowser-Manager
docker compose up --build
```

Takes ~15 minutes — it compiles the frontend and backend, installs KasmVNC and the
font set, and downloads the browser binary.

> **Early alpha** — this project is under active development. Expect bugs. If you find one, please [open an issue](https://github.com/SahilMahadwar/AstraBrowser-Manager/issues).

## Why Not Just Use a VPN?

A VPN only changes your IP. Incognito only clears cookies. Chrome profiles share the same hardware fingerprint underneath. Platforms use 50+ signals to link your accounts — canvas, WebGL, audio, GPU, fonts, screen size, timezone.

Each profile here generates a completely different device identity. To the website, each profile looks like a different computer.

| Solution                 | What it changes                                   | Accounts linked?                |
| ------------------------ | ------------------------------------------------- | ------------------------------- |
| VPN                      | IP address only                                   | Yes — same fingerprint          |
| Incognito                | Clears cookies                                    | Yes — same fingerprint          |
| Chrome profiles          | Separate bookmarks/cookies                        | Yes — same hardware fingerprint |
| **AstraBrowser Manager** | **Everything — full device identity per profile** | **No**                          |

## Browser Engines

| Engine                                                                    | Status          | Automation protocol                              |
| ------------------------------------------------------------------------- | --------------- | ------------------------------------------------ |
| [CloakBrowser](https://github.com/CloakHQ/CloakBrowser) (stealth Chromium) | Supported       | CDP — `chromium.connectOverCDP()`                |
| [Camoufox](https://github.com/daijro/camoufox) (stealth Firefox)           | Supported       | Playwright protocol — `firefox.connect()`        |
| Additional stealth engines                                                 | Coming soon     |                                                  |

Pick the engine per profile. The UI, proxies, VNC view, screenshots and profile
persistence are identical across both.

The **automation protocol is the one place they genuinely differ**, and it is not a
choice we made: Firefox removed its CDP implementation in version 141, so Camoufox has
no CDP endpoint to expose. Camoufox profiles are driven over Playwright's own protocol
instead, and `browser.contexts()[0]` is the profile's persistent context:

```js
// chromium profile
const browser = await chromium.connectOverCDP(profile.automation_url);
// camoufox profile
const browser = await firefox.connect(profile.automation_url);
const context = browser.contexts()[0];
```

Read `automation_protocol` off the profile and branch on it. `cdp_url` still works
exactly as before for Chromium profiles, and is `null` for Camoufox.

**Writing Camoufox scripts:** see [docs/CAMOUFOX.md](docs/CAMOUFOX.md) — client
setup, connecting remotely, the one gotcha that silently breaks scrapers ported
from Chromium, worked examples, and what to use instead of Stagehand.

## Features

- **Profile management** — create, edit, duplicate, and delete browser profiles with unique fingerprints
- **Per-profile settings** — fingerprint seed, proxy, timezone, locale, user agent, screen size, platform
- **One-click launch/stop** — each profile runs as an isolated browser instance
- **Session persistence** — cookies, localStorage, and cache survive browser restarts
- **In-browser viewing** — interact with launched browsers via noVNC, directly in the web GUI
- **Live previews** — optional thumbnails of every running profile, and a last-seen image for stopped ones
- **Proxy testing** — check a proxy and see its exit IP before you launch, instead of after it fails
- **Browser updates** — see the installed stealth Chromium and pull the newest published build without rebuilding the image
- **Export & import** — move profile configurations between machines as JSON
- **Search, filter, and tags** — filter by status or tag, sort by name or date, with keyboard shortcuts
- **Playwright/Puppeteer API** — connect to any running profile programmatically via CDP, while still watching it live in the browser
- **Optional authentication** — protect the web UI and API with a single token, or run wide open locally
- **Powered by CloakBrowser** — 32 source-level C++ patches, passes Cloudflare Turnstile, 0.9 reCAPTCHA v3 score

## Stack

- **Backend**: Hono (Node + TypeScript)
- **Frontend**: React + Tailwind CSS
- **Browser viewer**: noVNC (WebSocket-based VNC client)
- **Database**: SQLite
- **Browser engine**: [CloakBrowser](https://github.com/CloakHQ/CloakBrowser) (stealth Chromium binary)

## Requirements

- Docker (20.10+)
- ~2 GB disk (image + binary)
- ~512 MB RAM per running profile

## Run with Docker

Images are published to GitHub Container Registry on every push to `main`, built for
`linux/amd64`.

```bash
docker pull ghcr.io/sahilmahadwar/astra-browser-manager:latest

docker run -d --name astrabrowser-manager \
  -p 127.0.0.1:8080:8080 \
  -v ~/.astrabrowser-manager:/data \
  --shm-size=1g \
  --restart unless-stopped \
  ghcr.io/sahilmahadwar/astra-browser-manager:latest
```

Why each flag matters:

- `--shm-size=1g` — **not optional.** Chromium crashes on image-heavy pages with
  Docker's default 64 MB `/dev/shm`.
- `-v ~/.astrabrowser-manager:/data` — profiles, cookies, sessions, and the SQLite
  database live here. Without it, everything is lost when the container is removed.
- `-p 127.0.0.1:8080:8080` — binds to localhost only. Dropping the `127.0.0.1:`
  exposes an unauthenticated UI to your whole network; set
  [`AUTH_TOKEN`](#authentication) first, or use an [SSH tunnel](#remote-access).

### Environment variables

| Variable | Default | What it does |
| --- | --- | --- |
| `AUTH_TOKEN` | unset | Protects the UI and API with a token. Unset means every route is open. |
| `PORT` | `8080` | Port the server listens on inside the container. |
| `LOG_LEVEL` | `INFO` | Set `DEBUG` when diagnosing RFB filtering or CDP keepalive. |
| `PUBLIC_BASE_URL` | derived from `Host` | The URL agents should use to reach this server, e.g. `https://browsers.example.com`. Only needed behind a reverse proxy that rewrites `Host`; see [MCP Server](#mcp-server). |
| `CLOAKBROWSER_DATA_DIR` | `/data` | Where profiles and the database are stored. |
| `CLOAKBROWSER_LICENSE_KEY` | unset | Opts into the Pro browser binary. The free tier needs no key. |
| `CLOAKBROWSER_AUTO_UPDATE` | `true` | Whether the browser binary self-updates. |
| `CLOAKBROWSER_VERSION` | unset | Pins a specific browser build instead of the default. |

```bash
docker run -d --name astrabrowser-manager \
  -p 127.0.0.1:8080:8080 \
  -v ~/.astrabrowser-manager:/data \
  --shm-size=1g \
  -e AUTH_TOKEN=your-secret-token \
  -e LOG_LEVEL=DEBUG \
  ghcr.io/sahilmahadwar/astra-browser-manager:latest
```

### Image tags

| Tag | Points at |
| --- | --- |
| `latest` | Newest build from `main` |
| `main` | Same as `latest` |
| `sha-<short>` | A specific commit — use this to pin a known-good build |

### Managing the container

```bash
docker logs -f astrabrowser-manager     # follow the logs
docker stop astrabrowser-manager        # stop
docker start astrabrowser-manager       # start again
curl -fsS localhost:8080/api/status     # health check (never requires auth)
```

## Windows Fonts on Linux

Profiles default to `platform: windows`, but fonts come from the _host_ OS. A
Linux container claiming Windows while enumerating only Liberation fonts is a
contradiction that font-fingerprinting anti-bot systems flag
([CloakBrowser#395](https://github.com/CloakHQ/CloakBrowser/issues/395)).

The image ships [msttcorefonts](https://packages.debian.org/ttf-mscorefonts-installer)
(Arial, Times New Roman, Verdana, Courier New…) plus emoji/CJK/Thai coverage.
It does **not** ship the Microsoft-proprietary fonts that come with Windows
itself — they are not redistributable. CloakBrowser looks for eight:

> Segoe UI · Segoe UI Light · Calibri · Marlett · MS UI Gothic ·
> Franklin Gothic · Consolas · Courier New

Only Courier New arrives from msttcorefonts. To supply the rest, copy them from
a machine you hold a Windows license for (`C:\Windows\Fonts`) into the data
volume and restart:

```bash
cp /path/to/windows/fonts/*.tt[fc] ~/.astrabrowser-manager/fonts/
docker compose restart
```

`entrypoint.sh` registers `/data/fonts` with fontconfig on every start. The
server reports the result in its startup log — it names exactly which fonts are
still missing, so check there rather than guessing:

```
cloakbrowser.manager.browser INFO Windows font set complete — --fingerprint-windows-font-metrics will apply.
```

The check is all-or-nothing on purpose: a real Windows font install is atomic,
so a partial set is its own tell.

### `--fingerprint-windows-font-metrics`

Once the set is complete, add this flag to a profile's **Launch Args** to align
font metrics with Windows. Two caveats:

- It does nothing without the fonts above.
- It requires a **Chromium 148+** binary. `cloakbrowser@0.5.x` currently pins
  `146.0.7680.177.5`, which ignores the flag harmlessly — it activates on the
  next binary bump. To try it early, set `CLOAKBROWSER_VERSION` to a 148 build.

It is not enabled by default for exactly these reasons.

## Development

### Backend

Requires Node 22.5 or newer.

```bash
cd server
npm install
CLOAKBROWSER_DATA_DIR=/tmp/abm-dev PORT=8080 npm run dev
```

Launching profiles needs `Xvnc` and the browser binary, so it only works
inside Docker (or on a host with KasmVNC installed). Everything else — CRUD,
auth, the UI — works locally. See [server/README.md](server/README.md) for the
full development and acceptance-testing guide.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

### Docker

```bash
docker compose up --build
```

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for building
from source, running the checks, and opening issues and pull requests.

## Updating

Running the prebuilt image:

```bash
docker pull ghcr.io/sahilmahadwar/astra-browser-manager:latest
docker rm -f astrabrowser-manager
```

Then re-run the `docker run` command from [Run with Docker](#run-with-docker).

Building from source:

```bash
git pull
docker compose up --build -d
```

Your profiles and session data live in `~/.astrabrowser-manager` on the host and
persist across updates. If you are coming from CloakBrowser Manager, move your
existing data over once:

```bash
mv ~/.cloakbrowser-manager ~/.astrabrowser-manager
```

## Automation API

Every running profile exposes a CDP (Chrome DevTools Protocol) endpoint. Connect Playwright or Puppeteer to automate a profile while watching it live in the browser.

```python
from playwright.async_api import async_playwright

async with async_playwright() as pw:
    browser = await pw.chromium.connect_over_cdp(
        "http://localhost:8080/api/profiles/<profile-id>/cdp"
    )
    page = browser.contexts[0].pages[0]
    await page.goto("https://example.com")
```

```javascript
const { chromium } = require("playwright");

const browser = await chromium.connectOverCDP(
  "http://localhost:8080/api/profiles/<profile-id>/cdp",
);
const page = browser.contexts()[0].pages()[0];
await page.goto("https://example.com");
```

The CDP URL is available in the toolbar (code icon) when a profile is running. The same browser session is accessible both visually through VNC and programmatically through the API.

Every HTTP and WebSocket endpoint — profile CRUD, launch/stop, export/import,
screenshots, clipboard, proxy testing, and the CDP discovery routes — is documented in
the [API reference](docs/API.md).

## MCP Server

The manager also speaks [MCP](https://modelcontextprotocol.io), so an AI agent can manage profiles as tools instead of you writing a client per endpoint. The endpoint is `POST /mcp` on the same port as the UI, using the Streamable HTTP transport.

Twelve tools are exposed, covering the control plane rather than page actions:

| Tool | What it does |
| --- | --- |
| `list_profiles`, `get_profile`, `get_profile_status` | Read profiles and their live status |
| `create_profile`, `update_profile`, `delete_profile` | Manage profiles |
| `launch_profile`, `stop_profile`, `force_stop_profile` | Lifecycle |
| `get_cdp_url` | The CDP endpoint of a running profile, as an absolute URL |
| `take_screenshot` | JPEG of the current page (live if running, else last cached) |
| `test_proxy` | Check a proxy's reachability and exit IP before assigning it |

Page-level automation is deliberately *not* exposed: the agent gets a CDP URL from `launch_profile` and drives the browser with its own Playwright or Puppeteer client, which is far cheaper and more capable than routing every click through a model.

### Using it from Mastra

```ts
import { MCPClient } from "@mastra/mcp";
import { Agent } from "@mastra/core/agent";

const mcp = new MCPClient({
  servers: {
    astrabrowser: {
      url: new URL("http://localhost:8080/mcp"),
      requestInit: {
        headers: { Authorization: `Bearer ${process.env.ASTRA_TOKEN}` },
      },
    },
  },
});

export const browserAgent = new Agent({
  name: "browser-agent",
  instructions:
    "You manage AstraBrowser profiles. Launch one, then drive it over its CDP URL.",
  model: "anthropic/claude-sonnet-5",
  tools: await mcp.getTools(),
});
```

Drop the `requestInit` block if `AUTH_TOKEN` is unset. Then in your own tool or workflow step, connect to the URL the agent got back:

```ts
import { chromium } from "playwright";

const browser = await chromium.connectOverCDP(cdpUrl);
const page = browser.contexts()[0].pages()[0];
await page.goto("https://example.com");
```

`launch_profile` waits until the CDP endpoint actually accepts connections before returning (`wait_for_cdp`, default `true`), so this works on the next line without a retry loop.

### Other clients

Any MCP client that speaks Streamable HTTP works — point it at `http://<host>:8080/mcp` with an `Authorization: Bearer` header. For Claude Code:

```bash
claude mcp add --transport http astrabrowser http://localhost:8080/mcp \
  --header "Authorization: Bearer your-secret-token"
```

Note that `/mcp` requires the token when `AUTH_TOKEN` is set, and returns the CDP URL built from the request's `Host` header. Behind a reverse proxy that rewrites `Host`, or when agents reach the container by a different name, set `PUBLIC_BASE_URL` so the URLs handed to agents are the ones they can actually connect to.

## Remote Access

The container binds to localhost only. To access from a remote server:

```bash
ssh -L 8080:localhost:8080 your-server
```

Then open `http://localhost:8080`.

## Deploy to Railway

Everything the outside world needs — UI, API, MCP, and both the VNC and CDP
WebSockets — is multiplexed onto the single HTTP port, so one Railway service with one
domain exposes the whole manager. No code changes are needed.

Two ways to create the service, both from the dashboard (the `railway` CLI is only for
deploying a local directory):

- **Connect this repo** — *New Project → Deploy from GitHub repo*. Railway detects the
  root `Dockerfile` automatically and applies [`railway.json`](railway.json). Builds
  take ~15 minutes and rerun on every push to `main`.
- **Deploy the prebuilt image** — enter
  `ghcr.io/sahilmahadwar/astra-browser-manager:latest` as the image. No build time, but
  `railway.json` does not apply, so set the healthcheck and drain values by hand.

Attach a **volume mounted at `/data`** (profiles, cookies, sessions, and the SQLite
database live there; without it everything is lost on redeploy). Any other mount path
works too — the entrypoint picks up Railway's `RAILWAY_VOLUME_MOUNT_PATH` automatically.
If no volume is mounted, the deploy logs print a `WARNING: … is not a mounted volume`
at boot; a correctly attached volume logs `Data dir: /data` with no warning.
Replicas must stay at 1 — Railway forbids replicas on a service with a volume, and the
manager keeps its sessions in process anyway.

- **Size it for the profiles.** Each profile directory grows with its browser cache,
  typically tens to a few hundred MB. The 0.5 GB free-tier volume holds only a few;
  5 GB (Hobby) is a sensible minimum, and Pro volumes can be resized live.
- **Redeploys have a short gap.** Railway will not mount one volume on two deployments
  at once, so the old container stops before the new one starts.
- **Enable volume backups** in the volume's settings — the volume is the only copy of
  every logged-in session.
- **Do not add a `VOLUME` line to the Dockerfile.** Railway's build rejects it; the
  image deliberately has none.

Then set these variables:

| Variable | Value | Why |
| --- | --- | --- |
| `AUTH_TOKEN` | a long random secret | **Required.** The service gets a public URL, and without this every route is open. |
| `RAILWAY_SHM_SIZE_BYTES` | `1073741824` | Railway's equivalent of `--shm-size=1g`. Its default is 64 MB, on which Chromium crashes on image-heavy pages. |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `30` | Railway's SIGTERM→SIGKILL grace defaults to `0`, which kills the server mid-shutdown while it is still closing browsers and the database. Skip if you use `railway.json`, which sets `drainingSeconds`. |
| `PUBLIC_BASE_URL` | `https://<your>.up.railway.app` | Makes the CDP and MCP URLs handed to agents deterministic. |
| `CLOAKBROWSER_AUTO_UPDATE` | `false` | An in-place binary update writes ~700 MB to ephemeral storage, not the volume, so it is re-downloaded after every restart. Take browser updates by rebuilding instead. |

Disable **serverless / app sleeping** — a manager with auto-launch profiles never idles
cleanly, and cold starts return 502s.

Chromium's sandbox is already disabled in the browser's own defaults, which matters
because Railway grants no `SYS_ADMIN` and no seccomp overrides. Long-lived WebSockets
are safe: Railway exempts them from its idle and duration limits, and both proxies ping
the client leg every 20 seconds regardless.

After deploying, confirm `curl -fsS https://<domain>/api/status` returns 200, that
`/api/profiles` returns 401, and that `df -h /dev/shm` in the Railway shell reports
~1 GB rather than 64 MB.

## Authentication

By default, there is no authentication (ideal for local use). To protect the web UI and API when hosting on a network, set the `AUTH_TOKEN` environment variable in `docker-compose.yml`:

```yaml
environment:
  - AUTH_TOKEN=your-secret-token
```

Or pass it inline:

```bash
AUTH_TOKEN=your-secret-token docker compose up -d
```

With plain Docker, pass it as an environment variable:

```bash
docker run -d --name astrabrowser-manager \
  -p 127.0.0.1:8080:8080 \
  -v ~/.astrabrowser-manager:/data \
  --shm-size=1g \
  -e AUTH_TOKEN=your-secret-token \
  ghcr.io/sahilmahadwar/astra-browser-manager:latest
```

When `AUTH_TOKEN` is set:

- The web UI shows a login page. Enter the token to unlock.
- API consumers pass the token via `Authorization: Bearer <token>` header. This includes the [MCP endpoint](#mcp-server).
- VNC WebSocket connections are authenticated via the login cookie.
- The `/api/status` endpoint remains unauthenticated (for Docker healthcheck).

> **Note**: The auth token is transmitted in cleartext over HTTP. If you expose the Manager to the internet, put it behind a reverse proxy with HTTPS (Caddy, nginx, Traefik).

## License

- **This application** (GUI source code) — MIT. See [LICENSE](LICENSE).
- **CloakBrowser binary** (compiled Chromium) — free to use, no redistribution. See [BINARY-LICENSE.md](BINARY-LICENSE.md).

The GUI application requires the CloakBrowser Chromium binary to function. The binary is automatically downloaded on first launch and is governed by its own license terms. If you fork or redistribute this application, your users must comply with the [CloakBrowser Binary License](BINARY-LICENSE.md).

## Links

- **Bug reports** — [GitHub Issues](https://github.com/SahilMahadwar/AstraBrowser-Manager/issues)
- **CloakBrowser** — [github.com/CloakHQ/CloakBrowser](https://github.com/CloakHQ/CloakBrowser) · [cloakbrowser.dev](https://cloakbrowser.dev)
- **Camoufox** — [github.com/daijro/camoufox](https://github.com/daijro/camoufox)

---

## Fork Notice

AstraBrowser Manager is a fork of [CloakBrowser Manager](https://github.com/CloakHQ/CloakBrowser-Manager)
by CloakHQ, used under the MIT License. All credit for the original application
and for the CloakBrowser stealth Chromium engine goes to CloakHQ.

The CloakBrowser binary remains CloakHQ's property under the
[CloakBrowser Binary License](BINARY-LICENSE.md) and is not redistributed by this
project — it is downloaded from upstream at build time.

This project is independent and is not affiliated with, sponsored by, or endorsed
by CloakHQ.
