# Test scripts

End-to-end test for both browser engines against a running manager.

```bash
cd examples
npm install

BASE_URL=http://localhost:8080 npm test          # both engines
npm run test:camoufox                            # one engine
node test-profiles.mjs --keep                    # leave profiles running
```

Env vars: `BASE_URL` (default `http://localhost:8080`), `AUTH_TOKEN` (if the
server sets one), `TEST_PROXY` (optional), `OPENAI_API_KEY` (optional — see
below), `STAGEHAND_MODEL` (default `openai/gpt-4.1-mini`).

The script creates a throwaway profile per engine, launches it, drives it,
checks the fingerprint, verifies cookies and localStorage survive a stop and
relaunch, then deletes it.

## Why this isn't only a Stagehand script

**Stagehand is Chromium-only, in every version.** From its own migration guide:

> Chromium only. Stagehand has no Firefox or WebKit support.

It attaches over CDP, and Camoufox is Firefox 152 — Firefox deleted its CDP
implementation in 141. There is no endpoint for Stagehand to attach to. That is
not a gap in this server: nothing can drive Camoufox over CDP.

So each engine is driven by the client that can actually drive it:

| Engine | Client | Transport |
| --- | --- | --- |
| `chromium` | Stagehand (`act` / `extract`) | CDP |
| `camoufox` | Playwright `firefox.connect()` | Playwright protocol |

Both then run the *same* stealth and persistence assertions, which is the point
— the engines differ in transport and in nothing else that matters.

Without `OPENAI_API_KEY` the Chromium leg still runs every check, just over
plain `connectOverCDP` instead of Stagehand. Set the key to exercise the AI path.

## Stagehand version

Pinned to **3.7.2**, deliberately — do not bump to v4 without re-testing:

- v4 attaches by loading a Chrome extension through the CDP
  `Extensions.loadUnpacked` domain, which needs the target Chrome started with
  `--enable-unsafe-extension-debugging`. CloakBrowser is not, so v4 cannot
  attach to a manager profile.
- v4's `browser.close()` on a connected browser sends CDP `Browser.close`, which
  would kill the profile instead of just disconnecting from it.
- v4 removed `agent()` outright.

### API notes for 3.7.x

Worth knowing, because the widely-copied v2 snippets are wrong here and fail
quietly rather than loudly:

- Model config is **one object**: `model: { modelName, apiKey }`. The v2 pair
  `modelName` + `modelClientOptions` is silently ignored, after which the key
  falls back to the environment — so you get "API key is missing" while looking
  at the key you just passed.
- `act` / `extract` / `observe` are on the **Stagehand instance**, not on a page.
  There is no `stagehand.page`; pages come from `stagehand.context.pages()`.
- `extract(instruction, schema)` is positional and returns the object directly.
  It is not `extract({ instruction, schema })`, and it is not wrapped in `.data`
  (that is v4).
- `modelName` must be an allowlisted `provider/model` string, e.g.
  `openai/gpt-4.1-mini`.

## Playwright version

`playwright-core` is pinned to match the server (`~1.60.0`). A mismatch is not
rejected at connect time — Playwright's HTTP 428 guard reads a user-agent this
server's proxy does not forward — so it surfaces later as
`timeout: expected float, got undefined` on `goto` / `waitForSelector` /
`screenshot`. See `docs/CAMOUFOX.md`.

## Auth

When `AUTH_TOKEN` is set, the automation endpoints take it as `?token=`. That is
not just a convenience: Stagehand's only handoff for an existing browser is a
bare CDP URL string, and Playwright's `firefox.connect()` takes no headers
option at all — so for Camoufox the query parameter is the only channel there is.
