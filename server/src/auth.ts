/**
 * Optional token authentication. Ported from backend/main.py.
 *
 * If AUTH_TOKEN is unset every route is open (local dev). If set, all /api/*
 * routes except the exempt list require a Bearer header or auth_token cookie.
 *
 * The Python version needed raw ASGI middleware because Starlette's
 * BaseHTTPMiddleware wraps the request body and breaks WebSocket upgrades.
 * Hono has no such problem, so this is ordinary middleware.
 */

import { timingSafeEqual } from 'node:crypto';
import { getCookie } from 'hono/cookie';
import type { Context, MiddlewareHandler } from 'hono';

/** Paths that bypass auth even when AUTH_TOKEN is set. */
export const AUTH_EXEMPT = new Set([
  '/api/auth/status',
  '/api/auth/login',
  '/api/status',
]);

/**
 * Paths that additionally accept the token as a `?token=` query parameter.
 *
 * Header and cookie are the normal channels, but a CDP client cannot always use
 * either. Playwright's `connectOverCDP` takes a `headers` option; Stagehand
 * exposes only `localBrowserLaunchOptions.cdpUrl`, a bare URL string with
 * nowhere to hang a header. A query parameter is the one channel every CDP
 * client can carry.
 *
 * Deliberately narrow: tokens in URLs leak into access logs, referrers and
 * error traces in a way headers do not, so this covers the CDP subtree only —
 * not /api/profiles itself, and not /mcp.
 */
const QUERY_TOKEN_PATH = /^\/api\/profiles\/[^/]+\/cdp(\/|$)/;

export function allowsQueryToken(path: string): boolean {
  return QUERY_TOKEN_PATH.test(path);
}

export function getAuthToken(): string | null {
  return process.env.AUTH_TOKEN || null;
}

/** Constant-time comparison that tolerates length mismatch. */
function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * True when the request carries a valid token in a header, cookie, or — on the
 * CDP routes only — a `?token=` query parameter. See QUERY_TOKEN_PATH.
 */
export function checkAuth(c: Context): boolean {
  const token = getAuthToken();
  if (!token) return true;

  const authHeader = c.req.header('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    if (tokensMatch(authHeader.slice(7), token)) return true;
  }

  const cookie = getCookie(c, 'auth_token');
  if (cookie && tokensMatch(cookie, token)) return true;

  if (allowsQueryToken(new URL(c.req.url).pathname)) {
    const query = c.req.query('token');
    if (query && tokensMatch(query, token)) return true;
  }

  return false;
}

/** True when the original client connection was HTTPS (via reverse proxy). */
export function isHttps(c: Context): boolean {
  return (c.req.header('x-forwarded-proto') ?? '').includes('https');
}

export function authMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (!getAuthToken()) return next();

    const path = new URL(c.req.url).pathname;

    // The default is *open*, so that the static frontend loads. Every route that
    // does anything must therefore be listed here — /mcp exposes the whole
    // profile control plane and would otherwise be reachable without a token.
    const guarded =
      path.startsWith('/api/') || path === '/mcp' || path.startsWith('/mcp/');

    // Static frontend and exempt endpoints are always reachable.
    if (AUTH_EXEMPT.has(path) || !guarded) return next();

    if (checkAuth(c)) return next();

    return c.json({ detail: 'Unauthorized' }, 401);
  };
}

/**
 * Cross-Site WebSocket Hijacking protection.
 *
 * Browsers always send Origin on a WebSocket upgrade; non-browser clients
 * (Playwright, Puppeteer, curl) typically do not. A missing Origin is therefore
 * allowed — that is how automation connects. When present, its host must match
 * the Host header.
 */
export function checkWebSocketOrigin(
  origin: string | undefined,
  host: string | undefined
): boolean {
  if (!origin) return true; // non-browser client
  if (!host) return true; // nothing to compare against

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false; // malformed Origin
  }

  const originPort = parsed.port ? Number(parsed.port) : null;
  const originNetloc =
    originPort && originPort !== 80 && originPort !== 443
      ? `${parsed.hostname}:${originPort}`
      : parsed.hostname;

  // Some proxies send an explicit default port on Host; strip it to match.
  const hostNormalized =
    host.endsWith(':80') || host.endsWith(':443')
      ? host.slice(0, host.lastIndexOf(':'))
      : host;

  return originNetloc === hostNormalized;
}
