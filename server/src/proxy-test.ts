/**
 * Pre-flight proxy check.
 *
 * Without this, a bad proxy only surfaces as a failed launch, with the real cause
 * buried in the server log. This runs the same normalize/validate pair the launch
 * path uses, then actually routes a request through the proxy to prove it works
 * and to report the exit IP.
 */

import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

import { normalizeProxy, validateProxy } from './browser.js';
import { logger } from './logger.js';
import type { ProxyTestResponse } from './schemas.js';

const log = logger('proxy-test');

const TIMEOUT_MS = 10_000;
// Plain-text and tiny, so there is nothing to parse and nothing to leak.
const ECHO_HOST = 'api.ipify.org';
const ECHO_PATH = '/';
const MAX_BODY_BYTES = 256;

function agentFor(url: string) {
  return url.startsWith('socks') ? new SocksProxyAgent(url) : new HttpsProxyAgent(url);
}

/**
 * `fetch` cannot take a per-request proxy agent without pulling in undici
 * directly, so this uses node:https, which accepts one.
 */
function fetchExitIp(proxyUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        host: ECHO_HOST,
        path: ECHO_PATH,
        agent: agentFor(proxyUrl),
        timeout: TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Echo service returned HTTP ${res.statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > MAX_BODY_BYTES) {
            req.destroy();
            reject(new Error('Echo service response was unexpectedly large'));
          }
        });
        res.on('end', () => resolve(body.trim()));
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Proxy did not respond within ${TIMEOUT_MS / 1000}s`));
    });
    req.on('error', reject);
  });
}

/**
 * Never throws — every failure mode is a result the UI can display, and the
 * distinction between "malformed" and "unreachable" is exactly what the user
 * needs to see.
 */
export async function testProxy(raw: string): Promise<ProxyTestResponse> {
  let normalized: string;
  try {
    normalized = normalizeProxy(raw.trim());
    validateProxy(normalized);
  } catch (err) {
    return {
      ok: false,
      exit_ip: null,
      latency_ms: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const started = performance.now();
  try {
    const exitIp = await fetchExitIp(normalized);
    return {
      ok: true,
      exit_ip: exitIp,
      latency_ms: Math.round(performance.now() - started),
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Log without the proxy URL — it usually carries credentials.
    log.info(`Proxy test failed: ${message}`);
    return { ok: false, exit_ip: null, latency_ms: null, error: message };
  }
}
