# Agent Instructions

AstraBrowser Manager runs isolated stealth-browser profiles, each with its own
fingerprint and proxy, and streams them into the web UI over VNC. It is a fork of
CloakHQ's CloakBrowser Manager. Two engines are supported: upstream's
`cloakbrowser` npm package (Chromium) and Camoufox (Firefox), selected per profile
by the `engine` column and dispatched through `server/src/engines/`.

**The `CLOAKBROWSER_` prefix is deliberate.** `CLOAKBROWSER_DATA_DIR`,
`CLOAKBROWSER_LICENSE_KEY`, the `cloakbrowser` dependency, and the
`cloakbrowser.manager.*` log namespace all name the upstream engine, not this
app. Renaming them would break existing deployments and log pipelines for no
gain — leave them alone. User-facing strings say "AstraBrowser Manager".

## Architecture

One Docker container, one port (8080), one origin. `/data` is the persistent
volume: `profiles.db` plus a `profiles/<id>/` directory per profile.

| Path | What it is |
|---|---|
| `server/` | Backend. Hono 4 + `node:sqlite` + zod. **Requires Node ≥ 22.5** (`node:sqlite` is built in — no `better-sqlite3`, no build tools in the image). |
| `frontend/` | React 19 + Vite 6 + Tailwind 3 SPA. No router library, no react-query — hand-rolled polling in `useProfiles`, and hash-based routing in `useHashRoute` (`#/new`, `#/p/<id>/edit|view`) so refresh and Back work without server routes. |
| `archive/python-backend/` | The retired FastAPI implementation. **Reference only — never edit.** See its README. |

Per running profile: an `Xvnc` display (KasmVNC, from `:100` up), a websockify
port (from `6100`), an automation port (from `5100`), and a Playwright
`BrowserContext`. `server/src/browser.ts` owns all of it via `BrowserManager`,
which delegates the launch itself to an engine driver in `server/src/engines/`.

Request paths that matter:

- **VNC** — browser noVNC → `WS /api/profiles/:id/vnc` → `proxy/vnc.ts` → `rfb.ts`
  translation → KasmVNC. noVNC 1.4 and KasmVNC 1.3.3 do not speak the same RFB
  dialect; that translation layer is why this works at all.
- **CDP** — Playwright/Puppeteer → `WS /api/profiles/:id/cdp` → `proxy/cdp.ts` → Chromium.
- **Playwright protocol** — Playwright → `WS /api/profiles/:id/pw` → the same
  passthrough in `proxy/cdp.ts` → Camoufox. Firefox has no CDP, so this is a
  separate path, not a variant of the one above.
- **MCP** — agent (Mastra, Claude Code, …) → `POST /mcp` → `mcp/http.ts` (SDK
  Streamable HTTP transport) → `mcp/server.ts` → `profiles.ts`. The tools are the
  control plane only; for **Chromium** the agent drives the page itself over the
  CDP URL they hand back. **Camoufox is managed but not driven through MCP** — it
  has no CDP endpoint, and MCP deliberately does not expose its Playwright one
  (`test/mcp.test.ts` asserts that). `BrowserManager` state is in-process, so this
  cannot be split into a separate server — it would see no running sessions.
- **Static** — everything not under `/api/` falls through to `frontend/dist` with
  an SPA catch-all, registered last in `index.ts`.

## Commands

```bash
# Backend
cd server && npm run dev          # tsx watch, needs CLOAKBROWSER_DATA_DIR + PORT
cd server && npm test             # vitest, 292 tests
cd server && npm run typecheck    # tsc --noEmit
cd server && npm run build        # -> dist/

# Frontend
cd frontend && npm run dev        # :5173, proxies /api to :8080 (ws: true — required)
cd frontend && npm test
cd frontend && npm run build      # tsc -b && vite build

# Whole thing
docker compose up --build         # http://localhost:8080
```

Profile *launching* needs `Xvnc` and the engine's binary, so it only works
inside Docker (or on a host with KasmVNC installed). CRUD, auth, and the UI all
work locally. Local dev recipe and the full manual acceptance procedure are in
`server/README.md`.

## Gotchas that will bite you

Every one of these is load-bearing and was learned the hard way. Read before
touching the proxy, VNC, or launch paths.

- **Never ping the KasmVNC upstream leg.** KasmVNC never answers pings, so
  pinging it trips the pong timeout and kills healthy sessions. The VNC proxy
  pings the *client* leg only (`proxy/vnc.ts`), while the CDP proxy pings both.
  There is a test asserting the asymmetry (`test/vnc-proxy.test.ts`) — do not
  "fix" it.
- **Never regenerate a lockfile with npm ≤ 11.6.** npm 11.6 omits
  `@napi-rs/wasm-runtime`'s `@emnapi/*` peer entries; npm ≥ 11.10 (including the
  11.16 in `node:24-slim` and the npm 12 on GitHub runners) treats them as
  required and fails `npm ci` with `EUSAGE — Missing: @emnapi/core… from lock
  file`. That breaks both the CI test job and the image build, and it has
  happened twice. A lockfile written by npm ≥ 11.10 is accepted by every
  version, so use a current npm for any `npm install` that touches
  `server/package-lock.json`.
- **The three timeout-zeroing lines in `index.ts` are not redundant.** Node 18+
  reaps *upgraded* WebSockets at ~60s because `headersTimeout` is not cleared on
  upgrade. `headersTimeout = 0`, `requestTimeout = 0`, and `socket.setTimeout(0)`
  each defeat a different layer; the client-leg ping additionally defeats
  reverse-proxy idle timeouts that none of them reach. Remove any one and idle
  VNC views freeze at about a minute while still showing "Connected".
- **`RfbClientFilter` (`rfb.ts`) must stay stateful per connection.** RFB
  messages get split across WebSocket frames; a stateless filter drops the
  partial message, desyncs KasmVNC, and kills the session. A 50 KB clipboard
  paste is the regression test.
- **A missing `fingerprint_seed` is deliberately fatal** (`browser.ts`).
  cloakbrowser silently substitutes a hardcoded `--fingerprint=59720` when none
  is given, which would make every affected profile share one identity. The DB
  column is `NOT NULL`; the assertion catches a broken invariant.
- **`WINDOWS_FONT_TELLS` in `fonts.ts` is a hand-copy, not an import.**
  cloakbrowser keeps the same list in its private `dist/fonts.js`, but that
  module is not re-exported from its index and the package's `exports` map has
  no deep-import path, so importing it would break on any upstream release.
  Re-diff the two lists whenever cloakbrowser is bumped. Note also that
  `missingWindowsFonts()` returns `null` for "can't tell" and `[]` for
  "complete" — conflating them claims a Windows font set that was never
  verified.
- **`authMiddleware` defaults to *open* outside `/api/`.** That is what lets the
  static frontend load, which means every new route that does something must be
  added to the `guarded` check in `auth.ts` — `/mcp` exposes the whole control
  plane and would otherwise need no token at all. `test/mcp.test.ts` guards this.
- **Profile composition lives in `profiles.ts`, not in route handlers.** Deleting
  is stop + row + user-data dir + thumbnail; launching classifies proxy/seed
  errors as user error. REST and MCP both call those functions so the two cannot
  drift. Adding a front end means calling them, not re-implementing them.
- **API keys are `snake_case` on purpose.** The frontend consumes response
  bodies unchanged. Do not camelCase them.
- **Hono shares one route table between HTTP and WebSocket.** `GET /cdp` must
  yield to `next()` on an `Upgrade: websocket` header (`app.ts`) or CDP never
  connects. FastAPI kept these tables separate; Hono does not.
- **The Vite dev proxy needs `ws: true`.** The string shorthand forwards only
  plain HTTP, and both VNC and CDP are WebSockets under `/api`.
- **CDP ports rotate rather than scanning from the base** (`allocateCdpPort`),
  because a fast relaunch keeps colliding with ports in `TIME_WAIT`.
- **Proxy ports: don't trust `URL.port`.** It normalizes away a scheme's default
  port, so `http://host:80` reports `''` — which rejected every proxy on :80.
  Use `extractPort()` (`proxy-config.ts`, re-exported from `browser.ts`).
- **Camoufox has no CDP, and never will.** Firefox deleted its CDP
  implementation in 141; Camoufox is 152. `connectOverCDP` throws
  "CDP connections are only supported by Chromium". Do not add a `--remote-debugging-port`,
  a shim, or a "CDP-compatible" endpoint for it — the only transport is the
  Playwright protocol over `/pw`. `cdp_url` is null for those profiles on purpose:
  handing an existing CDP client a URL that cannot work fails far less clearly.
- **The Camoufox driver depends on two UNDOCUMENTED playwright-core options.**
  `launchServer({ _userDataDir, _sharedBrowser })` is what makes a persistent
  profile *and* a remote endpoint possible at once — `_userDataDir` routes the
  launch through `launchPersistentContext`, and `_sharedBrowser` sets
  `isolateContexts: false` so a connecting client can actually see that context.
  Drop `_sharedBrowser` and clients silently get a blank browser; drop
  `_userDataDir` and every Camoufox profile silently becomes a throwaway one.
  Neither failure is loud, so `test/engines-camoufox.test.ts` asserts both are
  still present in the installed bundle. If it fails, do not delete it — verify
  the mechanism by hand against the new version first.
- **`playwright-core` is pinned to `~1.60`** because `camoufox-js` peer-requires
  `<1.61.0`. cloakbrowser's peer range is `>=1.53.0`, so Chromium is unaffected.
- **The server stage's `npm ci --ignore-scripts` is load-bearing.** camoufox-js
  pulls in `better-sqlite3`, which carries a `binding.gyp`, so npm runs
  `node-gyp rebuild` on it implicitly — and the image has no Python or compiler
  by design. The compile is pointless anyway: better-sqlite3 ships N-API
  prebuilds in its own tarball and loads those at runtime. Drop the flag and the
  image build fails with `gyp ERR! find Python`. **Do not "fix" it by adding
  build-essential** — that is the constraint the whole image is built around.
  The *frontend* stage must not get the flag; Vite needs esbuild's binary.
  Note also that `better-sqlite3` is not dead weight: camoufox-js samples a WebGL
  fingerprint from a bundled sqlite DB on every `launchOptions()` call unless
  `block_webgl` is set, so it is on the main launch path. The Dockerfile
  smoke-checks exactly that after installing.
- **Use the wsEndpoint Playwright reports, verbatim.** With no `host` it binds
  IPv6 loopback and reports `ws://[::1]:PORT/...`; rebuilding that as
  `127.0.0.1` is a connection failure that reads like a dead browser. The driver
  passes `host: '127.0.0.1'` and still stores what it is handed back.
- **Firefox lock files are `.parentlock` and `lock`,** not Chromium's
  `Singleton*` set. Both the driver and `entrypoint.sh` clear them; miss one and
  a crashed container leaves the profile permanently unlaunchable.
- **`engine` is immutable after creation.** The user-data directory is written in
  the engine's own format, so switching would point a browser at a directory it
  cannot read. It is absent from `profileUpdateSchema` and from `UPDATABLE_COLS`,
  and `test/db.test.ts` asserts an update cannot change it.
- **Engine config is deliberately not shared.** Chromium reads the flat
  fingerprint columns; Camoufox reads `engine_config` and ignores them. Do not
  "unify" a field across both — the two engines spoof different surfaces, and one
  control that means two things is how a Camoufox change breaks a Chromium
  profile.

## Conventions

- TypeScript strict everywhere, both packages. Keep it that way.
- Tests: `server/test/*.test.ts` (vitest, node env), `frontend/src/**/*.test.ts`
  (vitest, jsdom).
- Comments explain **why**, not what. Match the surrounding density — this
  codebase documents its non-obvious decisions inline, and that is deliberate.
- Run `npm test` and `npm run typecheck` in `server/`, and `npm run build` in
  `frontend/`, before calling work done.

---

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
