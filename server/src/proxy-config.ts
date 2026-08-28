/**
 * Proxy string handling and the clipboard init script.
 *
 * Extracted from browser.ts so the engine drivers can use them without
 * importing the manager that owns them (which would be circular). browser.ts
 * re-exports everything here, so existing importers are unaffected.
 */

/**
 * Convert common proxy formats to http://user:pass@host:port.
 * Accepts an already-valid URL, host:port:user:pass, or host:port.
 */
export function normalizeProxy(raw: string): string {
  if (/^(https?|socks5):\/\//.test(raw)) return raw;
  const parts = raw.split(':');
  if (parts.length === 4) {
    const [host, port, user, passwd] = parts;
    return `http://${user}:${passwd}@${host}:${port}`;
  }
  if (parts.length === 2) return `http://${raw}`;
  return raw;
}

/**
 * Read the port straight out of a URL's authority.
 *
 * `new URL()` normalises away the default port for a scheme, so
 * `http://host:80` and `https://host:443` both report `port === ''` — unlike
 * Python's `urlparse`, which the original implementation relied on. Trusting
 * `URL.port` therefore rejected every HTTP proxy on :80 (Webshare and most
 * rotating-proxy vendors use exactly that).
 *
 * Handles userinfo containing ':' and '@', plus IPv6 literals.
 */
export function extractPort(url: string): string | null {
  const schemeEnd = url.indexOf('://');
  if (schemeEnd === -1) return null;

  const authority = url.slice(schemeEnd + 3).split(/[/?#]/)[0];
  // Passwords may contain ':' and '@', so the host starts after the LAST '@'.
  const at = authority.lastIndexOf('@');
  const hostPort = at === -1 ? authority : authority.slice(at + 1);

  if (hostPort.startsWith('[')) {
    // IPv6 literal: [::1]:8080
    const close = hostPort.indexOf(']');
    if (close === -1) return null;
    const rest = hostPort.slice(close + 1);
    return rest.startsWith(':') && /^\d+$/.test(rest.slice(1)) ? rest.slice(1) : null;
  }

  const colon = hostPort.lastIndexOf(':');
  if (colon === -1) return null;
  const port = hostPort.slice(colon + 1);
  return /^\d+$/.test(port) && port.length > 0 ? port : null;
}

/** Validate that a normalized proxy URL has scheme, host, and port. */
export function validateProxy(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Proxy URL is not parseable: ${url}`);
  }
  const scheme = parsed.protocol.replace(':', '');
  if (!['http', 'https', 'socks5'].includes(scheme)) {
    throw new Error(
      `Invalid proxy scheme '${scheme}'. Must be http, https, or socks5.`
    );
  }
  if (!parsed.hostname) throw new Error(`Proxy URL missing hostname: ${url}`);

  // parsed.port is empty for a scheme's default port, so fall back to the
  // raw authority before declaring the port missing. No range check is needed:
  // `new URL()` already rejects ports outside 1-65535 for every scheme.
  if (!parsed.port && !extractPort(url)) {
    throw new Error(`Proxy URL missing port: ${url}`);
  }
}

/**
 * Describe a proxy for the log without leaking the password.
 *
 * Whether credentials survived normalization decides which auth path
 * cloakbrowser takes — inline `--proxy-server` creds, or Playwright's CDP auth
 * interceptor, which prompts on some proxies. When a session unexpectedly asks
 * for proxy credentials, this line is what says which one was in play.
 */
export function describeProxy(url: string): string {
  try {
    const parsed = new URL(url);
    const port = parsed.port || extractPort(url) || '?';
    const creds = parsed.username ? 'with credentials' : 'no credentials';
    return `${parsed.protocol}//${parsed.hostname}:${port} (${creds})`;
  } catch {
    return '(unparseable)';
  }
}

/**
 * Injected into every page so GET /clipboard can read what the user copied.
 * Chrome under KasmVNC never writes to the X11 clipboard, so xclip can't see it.
 */
export const CLIPBOARD_INIT_JS = `
    window.__clipboardText = '';
    document.addEventListener('copy', () => {
        const sel = window.getSelection();
        if (sel) window.__clipboardText = sel.toString();
    });
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'c' && !e.altKey && !e.shiftKey) {
            const sel = window.getSelection();
            if (sel && sel.toString()) window.__clipboardText = sel.toString();
        }
    });
`;
