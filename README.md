<h1 align="center">AstraBrowser Manager</h1>

<h3 align="center">Browser profile manager for stealth Chromium</h3>

<p align="center">
Create, manage, and launch isolated browser profiles with unique fingerprints.<br>
Free, self-hosted alternative to Multilogin, GoLogin, and AdsPower.
</p>

<p align="center">
<a href="https://github.com/SahilMahadwar/AstraBrowser-Manager/stargazers"><img src="https://img.shields.io/github/stars/SahilMahadwar/AstraBrowser-Manager?label=stars" alt="Stars"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License"></a>
</p>

---

<p align="center">
<img src="https://i.imgur.com/twdX81Q.png" width="800" alt="AstraBrowser Manager — Browser View">
<br>
<img src="https://i.imgur.com/XFYn1qY.png" width="800" alt="AstraBrowser Manager — Profile Settings">
</p>

Each profile is an isolated stealth-Chromium instance with its own fingerprint, proxy, cookies, and session data. Profiles persist across restarts. Everything runs in one Docker container.

```bash
git clone https://github.com/SahilMahadwar/AstraBrowser-Manager.git
cd AstraBrowser-Manager
docker compose up --build
```

Open [http://localhost:8080](http://localhost:8080) in your browser. Create a profile. Click Launch. Done.

Or skip the build and pull the prebuilt image:

```bash
docker run -d --name astrabrowser-manager \
  -p 127.0.0.1:8080:8080 \
  -v ~/.astrabrowser-manager:/data \
  --shm-size=1g \
  ghcr.io/sahilmahadwar/astra-browser-manager:latest
```

`--shm-size=1g` is not optional — Chromium crashes on image-heavy pages with
Docker's default 64 MB `/dev/shm`.

> **Early alpha** — this project is under active development. Expect bugs. If you find one, please [open an issue](https://github.com/SahilMahadwar/AstraBrowser-Manager/issues).

## Why Not Just Use a VPN?

A VPN only changes your IP. Incognito only clears cookies. Chrome profiles share the same hardware fingerprint underneath. Platforms use 50+ signals to link your accounts — canvas, WebGL, audio, GPU, fonts, screen size, timezone.

Each profile here generates a completely different device identity. To the website, each profile looks like a different computer.

| Solution | What it changes | Accounts linked? |
|----------|----------------|-----------------|
| VPN | IP address only | Yes — same fingerprint |
| Incognito | Clears cookies | Yes — same fingerprint |
| Chrome profiles | Separate bookmarks/cookies | Yes — same hardware fingerprint |
| **AstraBrowser Manager** | **Everything — full device identity per profile** | **No** |

## Browser Engines

| Engine | Status |
|---|---|
| [CloakBrowser](https://github.com/CloakHQ/CloakBrowser) (stealth Chromium) | Supported today |
| [Camoufox](https://github.com/daijro/camoufox) (stealth Firefox) | Coming soon |
| Additional stealth engines | Coming soon |

The goal is one manager for every stealth browser — pick the engine per profile, keep the same UI, proxies, and automation API.

## Features

- **Profile management** — create, edit, duplicate, and delete browser profiles with unique fingerprints
- **Per-profile settings** — fingerprint seed, proxy, timezone, locale, user agent, screen size, platform
- **One-click launch/stop** — each profile runs as an isolated browser instance
- **Session persistence** — cookies, localStorage, and cache survive browser restarts
- **In-browser viewing** — interact with launched browsers via noVNC, directly in the web GUI
- **Live previews** — optional thumbnails of every running profile, and a last-seen image for stopped ones
- **Proxy testing** — check a proxy and see its exit IP before you launch, instead of after it fails
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

## Windows Fonts on Linux

Profiles default to `platform: windows`, but fonts come from the *host* OS. A
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

## Updating

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
  "http://localhost:8080/api/profiles/<profile-id>/cdp"
);
const page = browser.contexts()[0].pages()[0];
await page.goto("https://example.com");
```

The CDP URL is available in the toolbar (code icon) when a profile is running. The same browser session is accessible both visually through VNC and programmatically through the API.

## Remote Access

The container binds to localhost only. To access from a remote server:

```bash
ssh -L 8080:localhost:8080 your-server
```

Then open `http://localhost:8080`.

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

When `AUTH_TOKEN` is set:

- The web UI shows a login page. Enter the token to unlock.
- API consumers pass the token via `Authorization: Bearer <token>` header.
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
