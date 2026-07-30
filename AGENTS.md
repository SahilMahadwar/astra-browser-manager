# Agent Instructions

AstraBrowser Manager runs isolated stealth-Chromium profiles, each with its own
fingerprint and proxy, and streams them into the web UI over VNC. It is a fork of
CloakHQ's CloakBrowser Manager; the browser engine is still upstream's
`cloakbrowser` npm package.

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
port (from `6100`), a Chromium CDP port (from `5100`), and a Playwright
`BrowserContext`. `server/src/browser.ts` owns all of it via `BrowserManager`.

Request paths that matter:

- **VNC** — browser noVNC → `WS /api/profiles/:id/vnc` → `proxy/vnc.ts` → `rfb.ts`
  translation → KasmVNC. noVNC 1.4 and KasmVNC 1.3.3 do not speak the same RFB
  dialect; that translation layer is why this works at all.
- **CDP** — Playwright/Puppeteer → `WS /api/profiles/:id/cdp` → `proxy/cdp.ts` → Chromium.
- **Static** — everything not under `/api/` falls through to `frontend/dist` with
  an SPA catch-all, registered last in `index.ts`.

## Commands

```bash
# Backend
cd server && npm run dev          # tsx watch, needs CLOAKBROWSER_DATA_DIR + PORT
cd server && npm test             # vitest, 202 tests
cd server && npm run typecheck    # tsc --noEmit
cd server && npm run build        # -> dist/

# Frontend
cd frontend && npm run dev        # :5173, proxies /api to :8080 (ws: true — required)
cd frontend && npm test
cd frontend && npm run build      # tsc -b && vite build

# Whole thing
docker compose up --build         # http://localhost:8080
```

Profile *launching* needs `Xvnc` and the CloakBrowser binary, so it only works
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
  Use `extractPort()` (`browser.ts`).

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
