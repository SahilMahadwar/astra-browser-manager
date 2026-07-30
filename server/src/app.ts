/**
 * Hono application: REST API + static frontend. Ported from backend/main.py.
 *
 * WebSocket routes (VNC, CDP) are registered separately in index.ts, because
 * they need the upgradeWebSocket helper bound to the HTTP server.
 */

import { Hono, type Context } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';

import * as db from './db.js';
import { authMiddleware, checkAuth, getAuthToken, isHttps } from './auth.js';
import { getClipboard, setClipboard } from './clipboard.js';
import { probeCdp, rewriteBrowserWsUrl, rewritePageWsUrl } from './proxy/cdp.js';
import {
  clipboardRequestSchema,
  loginRequestSchema,
  profileCreateSchema,
  profileImportSchema,
  profileUpdateSchema,
  proxyTestRequestSchema,
  type ProfileImportResponse,
} from './schemas.js';
import { buildExport, readImport, resolveName, slugify } from './transfer.js';
import { getBinaryStatus, startUpdate } from './binary.js';
import { testProxy } from './proxy-test.js';
import { getScreenshot } from './screenshot.js';
import {
  createProfileFromInput,
  deleteProfileFully,
  launchProfileById,
  listProfilesWithStatus,
  withStatus,
} from './profiles.js';
import { mountMcp } from './mcp/http.js';
import { logger } from './logger.js';
import type { BrowserManager } from './browser.js';

const log = logger('api');

export function createApp(mgr: BrowserManager): Hono {
  const app = new Hono();

  app.use('*', authMiddleware());

  // ── MCP ───────────────────────────────────────────────────────────────────
  // Registered here rather than in index.ts so it lands before the SPA
  // catch-all, which only exempts /api/*.

  mountMcp(app, mgr);

  // ── Authentication ────────────────────────────────────────────────────────

  app.get('/api/auth/status', (c) =>
    c.json({
      auth_required: getAuthToken() !== null,
      authenticated: getAuthToken() ? checkAuth(c) : false,
    })
  );

  app.post('/api/auth/login', async (c) => {
    const token = getAuthToken();
    if (!token) return c.json({ ok: true });

    const parsed = loginRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ detail: 'Invalid token' }, 401);

    // Reuse the constant-time path rather than comparing here.
    const provided = parsed.data.token;
    if (
      provided.length !== token.length ||
      !Buffer.from(provided).equals(Buffer.from(token))
    ) {
      return c.json({ detail: 'Invalid token' }, 401);
    }

    setCookie(c, 'auth_token', token, {
      httpOnly: true,
      sameSite: 'Strict',
      secure: isHttps(c),
      path: '/',
    });
    return c.json({ ok: true });
  });

  app.post('/api/auth/logout', (c) => {
    deleteCookie(c, 'auth_token', {
      path: '/',
      secure: isHttps(c),
      sameSite: 'Strict',
    });
    return c.json({ ok: true });
  });

  // ── Profile CRUD ──────────────────────────────────────────────────────────

  app.get('/api/profiles', (c) => c.json(listProfilesWithStatus(mgr)));

  app.post('/api/profiles', async (c) => {
    const parsed = profileCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ detail: parsed.error.issues }, 422);
    }
    const profile = createProfileFromInput(parsed.data);
    return c.json(withStatus(mgr, profile), 201);
  });

  // ── Export / import ───────────────────────────────────────────────────────
  // Registered before /:id so "export" and "import" are not read as profile ids.

  app.get('/api/profiles/export', (c) => {
    const payload = buildExport(db.listProfiles(), new Date().toISOString());
    // Content-Disposition so the browser saves rather than renders it.
    c.header('Content-Disposition', 'attachment; filename="astrabrowser-profiles.json"');
    return c.json(payload);
  });

  app.post('/api/profiles/import', async (c) => {
    const parsed = profileImportSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ detail: parsed.error.issues }, 422);

    const entries = readImport(parsed.data);
    // Seed with existing names so imports never silently shadow a profile the
    // user already has.
    const taken = new Set(db.listProfiles().map((p) => p.name));

    const result: ProfileImportResponse = { created: 0, skipped: [], renamed: [] };

    for (const entry of entries) {
      const { tags, ...fields } = entry;
      const name = resolveName(entry.name, taken);
      try {
        db.createProfile({ ...fields, name, tags: tags ?? [] } as never);
        taken.add(name);
        result.created += 1;
        if (name !== entry.name) result.renamed.push({ from: entry.name, to: name });
      } catch (err) {
        // One bad entry must not abort the rest of the batch.
        const reason = err instanceof Error ? err.message : String(err);
        log.error(`Import failed for profile "${entry.name}": ${reason}`);
        result.skipped.push({ name: entry.name, reason });
      }
    }

    return c.json(result);
  });

  app.get('/api/profiles/:id', (c) => {
    const profile = db.getProfile(c.req.param('id'));
    if (!profile) return c.json({ detail: 'Profile not found' }, 404);
    return c.json(withStatus(mgr, profile));
  });

  app.get('/api/profiles/:id/export', (c) => {
    const profile = db.getProfile(c.req.param('id'));
    if (!profile) return c.json({ detail: 'Profile not found' }, 404);
    c.header(
      'Content-Disposition',
      `attachment; filename="${slugify(profile.name)}.json"`
    );
    return c.json(buildExport([profile], new Date().toISOString()));
  });

  app.put('/api/profiles/:id', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = profileUpdateSchema.safeParse(body);
    if (!parsed.success) return c.json({ detail: parsed.error.issues }, 422);

    // Only forward keys actually present in the request (Pydantic exclude_unset).
    const present: Record<string, unknown> = {};
    for (const key of Object.keys(body as object)) {
      if (key in parsed.data) present[key] = (parsed.data as Record<string, unknown>)[key];
    }

    const profile = db.updateProfile(c.req.param('id'), present);
    if (!profile) return c.json({ detail: 'Profile not found' }, 404);
    return c.json(withStatus(mgr, profile));
  });

  app.delete('/api/profiles/:id', async (c) => {
    const deleted = await deleteProfileFully(mgr, c.req.param('id'));
    if (!deleted) return c.json({ detail: 'Profile not found' }, 404);
    return c.json({ ok: true });
  });

  // ── Launch / Stop ─────────────────────────────────────────────────────────

  app.post('/api/profiles/:id/launch', async (c) => {
    const id = c.req.param('id');
    const result = await launchProfileById(mgr, id);

    if (result.ok === 'not_found') return c.json({ detail: 'Profile not found' }, 404);
    if (result.ok === 'conflict') {
      return c.json({ detail: 'Profile is already running' }, 409);
    }
    if (result.ok === 'bad_request') return c.json({ detail: result.message }, 400);
    if (result.ok === 'error') {
      log.error(`Failed to launch profile ${id}: ${result.message}`);
      return c.json({ detail: 'Failed to launch browser' }, 500);
    }

    return c.json({
      profile_id: id,
      status: 'running',
      vnc_ws_port: result.running.wsPort,
      display: `:${result.running.display}`,
      cdp_url: `/api/profiles/${id}/cdp`,
    });
  });

  app.post('/api/profiles/:id/stop', async (c) => {
    const id = c.req.param('id');
    if (!mgr.running.has(id)) return c.json({ detail: 'Profile is not running' }, 404);
    await mgr.stop(id);
    return c.json({ ok: true });
  });

  /**
   * Escape hatch for a wedged session: the manager still tracks the profile but
   * Chrome is gone, so a normal stop (which waits on the browser) cannot help.
   * Drops the tracking entry and tears down Xvnc.
   */
  app.post('/api/profiles/:id/force-stop', (c) => {
    const id = c.req.param('id');
    if (!mgr.running.has(id)) return c.json({ detail: 'Profile is not running' }, 404);
    mgr.evict(id);
    return c.json({ ok: true });
  });

  app.get('/api/profiles/:id/status', (c) => {
    const id = c.req.param('id');
    if (!db.getProfile(id)) return c.json({ detail: 'Profile not found' }, 404);
    return c.json(mgr.getStatus(id));
  });

  // ── Screenshots ───────────────────────────────────────────────────────────

  app.get('/api/profiles/:id/screenshot', async (c) => {
    const id = c.req.param('id');
    if (!db.getProfile(id)) return c.json({ detail: 'Profile not found' }, 404);

    const shot = await getScreenshot(id, mgr.running.get(id));
    if (!shot) return c.json({ detail: 'No screenshot available' }, 404);

    return c.body(new Uint8Array(shot.bytes), 200, {
      'Content-Type': 'image/jpeg',
      // Always revalidate: a thumbnail's whole value is being current, and the
      // client controls its own refresh cadence.
      'Cache-Control': 'no-store',
      // Lets the UI label a stopped profile's image as last-seen rather than live.
      'X-Screenshot-Cached': String(shot.cached),
    });
  });

  // ── Proxy check ───────────────────────────────────────────────────────────

  app.post('/api/proxy/test', async (c) => {
    const parsed = proxyTestRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ detail: parsed.error.issues }, 422);
    // Always 200 — a proxy that does not work is a successful test with a
    // negative result, not a failed request.
    return c.json(await testProxy(parsed.data.proxy));
  });

  // ── System status ─────────────────────────────────────────────────────────

  app.get('/api/status', async (c) => {
    let binaryVersion = 'unknown';
    try {
      // Re-exported from the package root; matches the Python original's
      // `from cloakbrowser.config import CHROMIUM_VERSION`.
      const { CHROMIUM_VERSION } = await import('cloakbrowser');
      binaryVersion = CHROMIUM_VERSION;
    } catch (err) {
      log.debug(`Could not read CHROMIUM_VERSION: ${String(err)}`);
    }
    return c.json({
      running_count: mgr.running.size,
      binary_version: binaryVersion,
      profiles_total: db.listProfiles().length,
    });
  });

  // ── Chromium binary ───────────────────────────────────────────────────────

  app.get('/api/binary', async (c) => c.json(await getBinaryStatus()));

  app.post('/api/binary/update', async (c) => {
    const status = await getBinaryStatus();
    if (!status.updatable) {
      return c.json(
        {
          detail:
            status.tier === 'pro'
              ? 'Pro builds are downloaded from cloakbrowser.dev with your licence key, not from GitHub. Run `cloakbrowser update` in the container.'
              : 'CLOAKBROWSER_BINARY_PATH is set — this install uses your own binary.',
        },
        409
      );
    }
    // Returns as soon as the download starts; the UI polls GET /api/binary.
    return c.json(startUpdate(), 202);
  });

  // ── Clipboard relay ───────────────────────────────────────────────────────

  app.post('/api/profiles/:id/clipboard', async (c) => {
    const running = mgr.running.get(c.req.param('id'));
    if (!running) return c.json({ detail: 'Profile not running' }, 404);

    const parsed = clipboardRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ detail: parsed.error.issues }, 422);

    await setClipboard(running.display, parsed.data.text);
    return c.json({ ok: true });
  });

  app.get('/api/profiles/:id/clipboard', async (c) => {
    const running = mgr.running.get(c.req.param('id'));
    if (!running) return c.json({ detail: 'Profile not running' }, 404);
    return c.json({ text: await getClipboard(running) });
  });

  // ── CDP discovery endpoints ───────────────────────────────────────────────
  // These must be declared before the SPA catch-all so /api/* is not swallowed.

  app.get('/api/profiles/:id/cdp', async (c, next) => {
    // FastAPI keeps @app.get and @app.websocket in separate route tables; Hono
    // does not, so this path is shared with the CDP WebSocket route registered
    // in index.ts. Yield to it on an upgrade request, or CDP never connects.
    if (c.req.header('upgrade')?.toLowerCase() === 'websocket') return next();

    const id = c.req.param('id');
    if (!mgr.running.has(id)) return c.json({ detail: 'Profile not running' }, 404);
    return c.json({
      cdp_url: `/api/profiles/${id}/cdp`,
      usage: `playwright.chromium.connect_over_cdp('http://<host>/api/profiles/${id}/cdp')`,
    });
  });

  const cdpJsonVersion = async (c: Context) => {
    const id = c.req.param('id') as string;
    const running = mgr.running.get(id);
    if (!running) return c.json({ detail: 'Profile not running' }, 404);

    try {
      const res = await fetch(`http://127.0.0.1:${running.cdpPort}/json/version`, {
        signal: AbortSignal.timeout(5000),
      });
      const data = (await res.json()) as Record<string, unknown>;
      data.webSocketDebuggerUrl = rewriteBrowserWsUrl(
        c.req.header('host') ?? 'localhost:8080',
        isHttps(c),
        id,
        c.req.query('token')
      );
      return c.json(data);
    } catch (err) {
      log.error(`CDP proxy: failed to reach Chrome CDP for ${id}: ${String(err)}`);
      return c.json({ detail: 'CDP endpoint unreachable' }, 502);
    }
  };
  app.get('/api/profiles/:id/cdp/json/version', cdpJsonVersion);
  app.get('/api/profiles/:id/cdp/json/version/', cdpJsonVersion);

  const cdpJsonList = async (c: Context) => {
    const id = c.req.param('id') as string;
    const running = mgr.running.get(id);
    if (!running) return c.json({ detail: 'Profile not running' }, 404);

    try {
      const res = await fetch(`http://127.0.0.1:${running.cdpPort}/json/list`, {
        signal: AbortSignal.timeout(5000),
      });
      const data = (await res.json()) as Array<Record<string, unknown>>;
      const host = c.req.header('host') ?? 'localhost:8080';
      const token = c.req.query('token');
      for (const entry of data) {
        if (typeof entry.webSocketDebuggerUrl === 'string') {
          entry.webSocketDebuggerUrl = rewritePageWsUrl(
            entry.webSocketDebuggerUrl,
            host,
            isHttps(c),
            id,
            token
          );
        }
      }
      return c.json(data);
    } catch (err) {
      log.error(`CDP proxy: failed to reach Chrome CDP for ${id}: ${String(err)}`);
      return c.json({ detail: 'CDP endpoint unreachable' }, 502);
    }
  };
  // Playwright probes several of these spellings; mirror the Python routes.
  app.get('/api/profiles/:id/cdp/json/list', cdpJsonList);
  app.get('/api/profiles/:id/cdp/json/list/', cdpJsonList);
  app.get('/api/profiles/:id/cdp/json', cdpJsonList);
  app.get('/api/profiles/:id/cdp/json/', cdpJsonList);

  /** Exposed so the WS route can 404 a wedged browser instead of hanging. */
  app.get('/api/profiles/:id/cdp/alive', async (c) => {
    const running = mgr.running.get(c.req.param('id'));
    if (!running) return c.json({ alive: false }, 404);
    return c.json({ alive: await probeCdp(running.cdpPort) });
  });

  return app;
}
