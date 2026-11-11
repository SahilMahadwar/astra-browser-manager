# Contributing to AstraBrowser Manager

Thanks for helping out. This guide covers building from source, where the code
lives, running the checks, and opening issues and pull requests. For the
architecture and the non-obvious pitfalls, read [AGENTS.md](AGENTS.md).

## Build and run from source

```bash
git clone https://github.com/SahilMahadwar/astra-browser-manager.git
cd astra-browser-manager
docker compose up --build
```

The first build takes about 15 minutes — it compiles the frontend and backend,
installs KasmVNC and the font set, and downloads the browser binary. Later builds
reuse Docker's layer cache. Open http://localhost:8080 when it is up. Profiles and
session data persist in `~/.astrabrowser-manager` on the host.

## Where the code lives

- `server/` — the backend: Node/TypeScript on Hono, the browser engine drivers
  (`src/engines/`), the VNC and CDP proxies, and the MCP server. Tests are in
  `server/test/`.
- `frontend/` — the web UI: a React 19 + Vite 6 + Tailwind 3 single-page app.
- `docs/` — reference docs: [API.md](docs/API.md) (REST and automation API) and
  [CAMOUFOX.md](docs/CAMOUFOX.md).
- `examples/` — a runnable automation example; see [examples/README.md](examples/README.md).
- `Dockerfile`, `docker-compose.yml`, `entrypoint.sh` — the single-container image.

## Local development

Requires Node 22.5 or newer (the backend uses the built-in `node:sqlite`).

```bash
# Backend, on :8080
cd server
npm install
CLOAKBROWSER_DATA_DIR=/tmp/abm-dev PORT=8080 npm run dev

# Frontend, on :5173 — proxies /api to :8080
cd ../frontend
npm install
npm run dev
```

Launching profiles needs `Xvnc` and the browser binary, so it only works inside
Docker (or on a host with KasmVNC installed). Everything else — CRUD, auth, the
UI — works locally. [server/README.md](server/README.md) has the full development
and manual acceptance-testing guide.

## Checks and tests

These are the same steps CI runs on pull requests and pushes to `main`. Run them
before opening a PR.

```bash
# Backend: typecheck + vitest
cd server
npm ci
npx playwright-core install --with-deps firefox   # for the Playwright contract tests
npm run typecheck
npm test

# Frontend: build (which is also the typecheck) + vitest
cd ../frontend
npm ci
npm run build
npm test
```

If your change touches a `package-lock.json`, use npm 11.10 or newer. Lockfiles
written by older npm versions make `npm ci` fail in CI and in the image build.

## Reporting issues

Open an issue at
[github.com/SahilMahadwar/astra-browser-manager/issues](https://github.com/SahilMahadwar/astra-browser-manager/issues).
For bugs, include:

- Steps to reproduce, and what you expected instead
- The browser engine (Chromium or Camoufox)
- The image tag or commit you are running
- Relevant container logs — `LOG_LEVEL=DEBUG` gives more detail

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep the change focused on one thing; add or update tests for behavior changes.
3. Run the checks above.
4. Open a pull request against `main` describing what changed and how you tested it.
