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

/** True when the request carries a valid token in either header or cookie. */
export function checkAuth(c: Context): boolean {
  const token = getAuthToken();
  if (!token) return true;

  const authHeader = c.req.header('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    if (tokensMatch(authHeader.slice(7), token)) return true;
  }

  const cookie = getCookie(c, 'auth_token');
  if (cookie && tokensMatch(cookie, token)) return true;

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

    // Static frontend and exempt endpoints are always reachable.
    if (AUTH_EXEMPT.has(path) || !path.startsWith('/api/')) return next();

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
