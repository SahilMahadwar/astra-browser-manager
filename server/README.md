# Node/Hono backend

The backend. Originally a port of the FastAPI implementation now archived in
`archive/python-backend/` — see that directory's README for what changed and why.

## Status

Verified in the container:

- Image builds (1.9 GB vs 2.16 GB for the old Python image) and boots; browser binary baked in (697 MB)
- Profile launches: `Xvnc :100` + Chromium with `DISPLAY=:100` and the profile's
  own `--fingerprint=<seed>` (not cloakbrowser's shared default)
- CDP: connect → attach → navigate → evaluate, through the proxy.
  `navigator.platform` reports `Win32` on Linux, so spoofing is live
- CDP keepalive: 75s fully idle, server pinged every 20s, command after idle worked
- VNC/RFB against real KasmVNC: full handshake, pixels flowing (10 framebuffer
  updates), click + keypress + a 60 KB paste, `dropped=0 buffered=0`
- Static assets served with correct MIME types; path traversal contained
- Hard `docker kill` → restart → auto-launch restored the profile

- **Idle VNC session survives 185s** (previously died at ~57s) — see below
- geoip profiles launch (`GeoLite2-City.mmdb` loaded)

### The frozen-view bug, and why it happened

Node 18+ closes **upgraded** WebSocket connections after ~60s: `headersTimeout`
defaults to min(`requestTimeout`, 60s) and its timer is not cleared on upgrade,
so a long-lived socket is reaped as if it were a client that never finished
sending request headers ([node-http-proxy#1664](https://github.com/http-party/node-http-proxy/issues/1664),
[nodejs/node#35661](https://github.com/nodejs/node/issues/35661)).

A VNC session is idle whenever the remote screen is not changing, so the view
froze about a minute after opening while still showing "Connected". CDP was
unaffected only because that proxy already pinged.

Fixed in three independent layers:

1. `headersTimeout = 0` / `requestTimeout = 0` on the HTTP server (`src/index.ts`)
2. ping/pong keepalive on the VNC **client leg** (`src/proxy/vnc.ts`) — this also
   defeats reverse-proxy idle timeouts, e.g. nginx's 60s `proxy_read_timeout`,
   which layer 1 alone would not
3. `socket.setTimeout(0)` on upgrade

The upstream leg to KasmVNC stays **ping-free** — KasmVNC never answers pings, so
pinging it would trip the timeout and kill healthy sessions. There is a test
asserting we do not ping upstream; do not "fix" that asymmetry.

**Not yet verified** — these need a human at a browser:

- The UI rendering and behaving in an actual browser (only asset MIME types were checked)
- Whether clicks land at the *right coordinates* (KasmVNC accepted the rewritten
  PointerEvents; nobody has confirmed the pointer goes where you aim it)
- Clipboard round-trip through the UI, and viewer auto-reconnect on a real drop

## Is the frontend hooked up?

Yes, both ways:

- **Production** — `src/index.ts` serves `frontend/dist` as static files with an
  SPA catch-all, and `/api/*` is registered first so it is never swallowed.
  One origin, one port, so the frontend's relative `fetch("/api/...")` calls and
  the `ws://<same-host>/api/profiles/<id>/vnc` WebSocket both just work.
- **Dev** — `frontend/vite.config.ts` proxies `/api` to `localhost:8080`.
  This now sets `ws: true`; without it the dev proxy forwards only plain HTTP and
  the VNC viewer never connects.

No frontend API code changed. Response shapes are byte-identical (snake_case
keys preserved deliberately).

---

## Run it

### Option A — Docker (closest to production)

```bash
docker compose up --build
```

Open <http://localhost:8080>. Profiles live in `~/.astrabrowser-manager`.
Override the host port with `PORT=8090 docker compose up`.

### Option B — local dev, two terminals

The browser needs `Xvnc` and the CloakBrowser binary, so profile *launching*
only works inside Docker (or on a host with KasmVNC installed). Everything else
— CRUD, auth, the UI — works locally.

```bash
# terminal 1
cd server
npm install
CLOAKBROWSER_DATA_DIR=/tmp/abm-dev PORT=8080 npm run dev

# terminal 2
cd frontend
npm install
npm run dev        # http://localhost:5173, proxies /api to :8080
```

---

## Test it

### 1. Unit tests (no Docker needed)

```bash
cd server && npm test        # 174 tests
npx tsc --noEmit             # typecheck
```

### 2. Smoke test the API

```bash
curl -s localhost:8080/api/status
# {"running_count":0,"binary_version":"146.0.7680.177.5","profiles_total":0}

curl -s -X POST localhost:8080/api/profiles \
  -H 'content-type: application/json' -d '{"name":"Test","platform":"macos"}'

curl -s localhost:8080/api/bogus     # must be {"detail":"Not found"}, not HTML
curl -s localhost:8080/ | head -c 40 # must be <!DOCTYPE html>
```

Export/import round-trip, the one worth checking by hand:

```bash
curl -s localhost:8080/api/profiles/export > profiles.json
curl -s -X POST localhost:8080/api/profiles/import \
  -H 'content-type: application/json' -d @profiles.json
# {"created":N,"skipped":[],"renamed":[{"from":"X","to":"X (imported)"}...]}
```

Importing an export of the current profiles must **rename**, never overwrite —
that is what keeps an accidental double-import from clobbering live profiles.

Proxy check (no profile needed):

```bash
curl -s -X POST localhost:8080/api/proxy/test \
  -H 'content-type: application/json' -d '{"proxy":"host:port:user:pass"}'
# {"ok":true,"exit_ip":"1.2.3.4","latency_ms":346,"error":null}
```

A malformed or unreachable proxy returns HTTP **200** with `ok:false` and a
reason — it is a successful test with a negative result, not a failed request.

### 3. The UI

Open <http://localhost:8080>, create a profile, click **Launch**. You should see
Chromium inside the page. Then check, in order:

- clicks land where you click (proves the 6→11 byte PointerEvent rewrite)
- scrolling works (mask-bit scroll encoding)
- typing works
- open a **Detection Tests** bookmark and confirm a non-default fingerprint
- relaunch the profile — the fingerprint must be identical (seed is stable)

### 4. CDP — the acceptance gate

This is the priority. Get the profile ID from the UI (or `/api/profiles`).

```bash
pip install playwright
```

```python
import asyncio
from playwright.async_api import async_playwright

PROFILE = "<profile-id>"

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.connect_over_cdp(
            f"http://localhost:8080/api/profiles/{PROFILE}/cdp")
        page = b.contexts[0].pages[0]
        await page.goto("https://example.com")
        print(await page.title())

        # THE regression test: idle longer than any LB timeout, then use it.
        print("idling 10 minutes...")
        await asyncio.sleep(630)
        await page.goto("https://example.org")
        print("survived idle:", await page.title())

asyncio.run(main())
```

**The 10-minute idle is the whole point.** The Python backend disabled
WebSocket pings on the CDP proxy, so an idle session gets silently reaped and
dies on the next command. This build pings every 20s. If this script prints
`survived idle:`, the fix holds.

Also worth running:

- a script doing 50 navigate/click/evaluate cycles (stability under load)
- `docker exec <container> pkill -f chrome` mid-session — the client must get a
  clean close, and reconnecting must return 404 rather than hang

### 5. MCP

The MCP server is mounted at `POST /mcp` (`src/mcp/`). Unit tests cover CRUD and
auth; what only Docker can prove is the launch path.

```bash
mcp() {
  curl -s -X POST http://localhost:8080/mcp \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    ${AUTH_TOKEN:+-H "authorization: Bearer $AUTH_TOKEN"} \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"
}

mcp create_profile '{"name":"mcp-test"}'
mcp launch_profile '{"id":"<profile-id>"}'   # expect cdp_ready: true + absolute cdp_url
mcp get_cdp_url    '{"id":"<profile-id>"}'   # expect alive: true
```

The `cdp_url` from `launch_profile` must be absolute and immediately usable —
feed it straight into the Playwright script in step 4. The profile must also
appear and stream in the UI, i.e. an MCP launch is indistinguishable from a UI
launch. With `AUTH_TOKEN` set, the same call without the header must be a 401.

### 6. VNC disconnects

- **Paste a very large clipboard payload** into the browser view. This is the
  direct regression test: the old filter dropped any RFB message split across
  WebSocket frames, which desynced KasmVNC and killed the session. A 50 KB paste
  previously lost 100% of its bytes.
- Leave a session open 30+ minutes with light activity — it must not self-close.
- `docker exec <container> pkill -f Xvnc` — the viewer must show
  `Reconnecting…` and recover, not eject you to the edit screen.

### 7. Restart safety

```bash
docker compose kill    # ungraceful, on purpose
docker compose up
```

Profiles must relaunch cleanly — `entrypoint.sh` clears stale `Xvnc`
processes, Chrome `SingletonLock` files, and X11 locks.

---

## The switchover (done)

This backend replaced the Python one. `Dockerfile`, `entrypoint.sh`, and
`docker-compose.yml` at the repo root now build and run Node on :8080 against
the same host volume the Python backend used — the SQLite schema and all three
`ALTER TABLE` migrations are byte-compatible, so existing `profiles.db` files are
read as-is with no migration step.

The Python implementation and its Docker files are in `archive/python-backend/`.
They are reference only and do not build in place; that directory's README
explains how to run them if you ever need to.

---

## Known differences from the Python backend

Three deliberate behaviour changes, all fixes:

1. **CDP keepalive.** Ping/pong every 20s on both legs, plus drain-on-close and
   a liveness probe. The VNC proxy still has pings **disabled** — KasmVNC never
   answers them, so pinging it would kill healthy sessions. The inconsistency is
   intentional.
2. **RFB frame reassembly.** `RfbClientFilter` is stateful per connection and
   buffers partial messages across WebSocket frames.
3. **Missing fingerprint seed is fatal.** cloakbrowser 0.5.2 substitutes a
   hardcoded `--fingerprint=59720` when none is given, which would silently make
   every affected profile share one identity. The DB column is `NOT NULL`, so
   this only fires if that invariant breaks.

Two incidental fixes found while porting: a spawn failure of `Xvnc` no longer
crashes the process, and proxy validation happens before Xvnc starts rather than
after.

`node:sqlite` prints an `ExperimentalWarning` at boot. It is dependency-free,
unlike `better-sqlite3` which needs build tools in the image.
