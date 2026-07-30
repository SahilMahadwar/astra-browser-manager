/**
 * MCP tool surface over the profile control plane.
 *
 * Deliberately scoped to *managing* profiles, not driving them. Agents get a
 * profile running and a CDP URL back; the actual page automation happens in the
 * agent's own Playwright/Puppeteer client over that URL, which is both far
 * cheaper than round-tripping every click through an LLM and the reason the CDP
 * proxy exists in the first place.
 *
 * Because BrowserManager keeps its state in-process (`mgr.running`), this server
 * has to live inside the HTTP server's process — an out-of-process MCP server
 * could not see a single running session.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import * as db from './../db.js';
import { probeCdp } from './../proxy/cdp.js';
import { getScreenshot } from './../screenshot.js';
import { testProxy } from './../proxy-test.js';
import {
  absoluteCdpUrl,
  createProfileFromInput,
  deleteProfileFully,
  getProfileWithStatus,
  launchProfileById,
  listProfilesWithStatus,
  withStatus,
} from './../profiles.js';
import {
  profileCreateSchema,
  profileUpdateSchema,
  proxyTestRequestSchema,
} from './../schemas.js';
import type { BrowserManager } from './../browser.js';

export const MCP_SERVER_NAME = 'astrabrowser-manager';
export const MCP_SERVER_VERSION = '0.1.0';

/** Base URL the agent should use to reach this server, e.g. http://host:8080. */
export interface McpContext {
  baseUrl: string;
}

const idSchema = { id: z.string().describe('Profile id (uuid)') };

/** Success: the payload as pretty JSON, which is what models read best. */
function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Expected failure. Returned as a tool error rather than thrown: a thrown error
 * becomes a JSON-RPC protocol error, which most clients surface as "the tool
 * broke" instead of handing the model something it can act on.
 */
function fail(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

/** Status plus an absolute, directly connectable CDP URL. */
function statusWithCdp(mgr: BrowserManager, ctx: McpContext, id: string) {
  const status = mgr.getStatus(id);
  return {
    ...status,
    cdp_url: status.cdp_url ? absoluteCdpUrl(ctx.baseUrl, id) : null,
  };
}

export function buildMcpServer(mgr: BrowserManager, ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      instructions:
        'Manage AstraBrowser stealth-Chromium profiles. Each profile is an isolated ' +
        'browser identity with its own fingerprint, proxy and user-data directory. ' +
        'Typical flow: create_profile (or list_profiles) -> launch_profile -> connect ' +
        'your own Playwright/Puppeteer client to the returned cdp_url with ' +
        'chromium.connectOverCDP(cdp_url) -> stop_profile when done. Page-level ' +
        'actions (navigate, click, type) are performed over CDP, not through these tools.',
    }
  );

  // ── Read ──────────────────────────────────────────────────────────────────

  server.registerTool(
    'list_profiles',
    {
      title: 'List profiles',
      description:
        'List every browser profile with its live status (running/stopped). Start ' +
        'here to find the id of an existing profile.',
      // No inputSchema at all, not an empty one: an empty z.object() still gets
      // parsed, and clients calling a no-arg tool routinely omit `arguments`
      // entirely — which then fails validation as "expected object, received
      // undefined". Omitting it advertises the same empty schema and skips the parse.
    },
    async () => ok(listProfilesWithStatus(mgr))
  );

  server.registerTool(
    'get_profile',
    {
      title: 'Get profile',
      description:
        'Full configuration and live status of one profile: fingerprint seed, proxy, ' +
        'timezone, locale, platform, screen size, tags and notes.',
      inputSchema: idSchema,
    },
    async ({ id }) => {
      const profile = getProfileWithStatus(mgr, id);
      return profile ? ok(profile) : fail(`No profile with id ${id}.`);
    }
  );

  server.registerTool(
    'get_profile_status',
    {
      title: 'Get profile status',
      description:
        'Whether a profile is running, plus its VNC port, X display and absolute ' +
        'CDP URL. Cheaper than get_profile when you only need liveness.',
      inputSchema: idSchema,
    },
    async ({ id }) => {
      if (!db.getProfile(id)) return fail(`No profile with id ${id}.`);
      return ok(statusWithCdp(mgr, ctx, id));
    }
  );

  server.registerTool(
    'get_cdp_url',
    {
      title: 'Get CDP URL',
      description:
        'Chrome DevTools Protocol endpoint for a running profile. Connect to it with ' +
        'playwright chromium.connectOverCDP(cdp_url) or puppeteer.connect({ ' +
        'browserURL: cdp_url }) to drive the browser. Fails if the profile is not ' +
        'running — call launch_profile first.',
      inputSchema: idSchema,
    },
    async ({ id }) => {
      const running = mgr.running.get(id);
      if (!running) {
        return fail(
          `Profile ${id} is not running. Call launch_profile first, then retry.`
        );
      }
      const alive = await probeCdp(running.cdpPort);
      return ok({
        cdp_url: absoluteCdpUrl(ctx.baseUrl, id),
        alive,
        usage: `chromium.connectOverCDP('${absoluteCdpUrl(ctx.baseUrl, id)}')`,
      });
    }
  );

  // ── Write ─────────────────────────────────────────────────────────────────

  server.registerTool(
    'create_profile',
    {
      title: 'Create profile',
      description:
        'Create a new browser profile. Only `name` is required; a random ' +
        'fingerprint_seed is generated when omitted, which is what you normally ' +
        'want — reusing a seed across profiles makes them look like the same ' +
        'machine. Set `proxy` as a full URL, e.g. http://user:pass@host:port. ' +
        'Creating does not launch it.',
      inputSchema: profileCreateSchema.shape,
    },
    async (input) => ok(withStatus(mgr, createProfileFromInput(input)))
  );

  server.registerTool(
    'update_profile',
    {
      title: 'Update profile',
      description:
        'Change a profile\'s configuration. Only the fields you pass are written; ' +
        'everything else is left alone. Changes take effect on the next launch.',
      inputSchema: { ...idSchema, ...profileUpdateSchema.shape },
    },
    async ({ id, ...fields }) => {
      // Mirror the REST route's exclude_unset behaviour: an absent key must not
      // be written as null.
      const present: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) present[key] = value;
      }

      const profile = db.updateProfile(id, present);
      return profile ? ok(withStatus(mgr, profile)) : fail(`No profile with id ${id}.`);
    }
  );

  server.registerTool(
    'delete_profile',
    {
      title: 'Delete profile',
      description:
        'Permanently delete a profile: stops it if running, then removes its record, ' +
        'its user-data directory (cookies, localStorage, logins) and its thumbnail. ' +
        'This cannot be undone.',
      inputSchema: idSchema,
    },
    async ({ id }) => {
      const deleted = await deleteProfileFully(mgr, id);
      return deleted ? ok({ ok: true, id }) : fail(`No profile with id ${id}.`);
    }
  );

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  server.registerTool(
    'launch_profile',
    {
      title: 'Launch profile',
      description:
        'Start the browser for a profile and return its absolute CDP URL, ready for ' +
        'chromium.connectOverCDP(). By default this waits until the DevTools ' +
        'endpoint answers, so you can connect immediately on success. Requires the ' +
        'CloakBrowser binary and an X server, so it only works in the Docker image.',
      inputSchema: {
        ...idSchema,
        wait_for_cdp: z
          .boolean()
          .default(true)
          .describe('Wait until the CDP endpoint accepts connections before returning.'),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .default(15_000)
          .describe('How long to wait for CDP readiness.'),
      },
    },
    async ({ id, wait_for_cdp, timeout_ms }) => {
      const result = await launchProfileById(mgr, id, {
        waitForCdp: wait_for_cdp,
        timeoutMs: timeout_ms,
      });

      switch (result.ok) {
        case 'not_found':
          return fail(`No profile with id ${id}.`);
        case 'conflict':
          return fail(
            `Profile ${id} is already running. Use get_cdp_url to get its endpoint, ` +
              `or stop_profile first.`
          );
        case 'bad_request':
          return fail(`Cannot launch profile ${id}: ${result.message}`);
        case 'error':
          return fail(`Failed to launch profile ${id}: ${result.message}`);
      }

      return ok({
        profile_id: id,
        status: 'running',
        cdp_url: absoluteCdpUrl(ctx.baseUrl, id),
        cdp_ready: wait_for_cdp ? result.cdpReady : null,
        vnc_ws_port: result.running.wsPort,
        display: `:${result.running.display}`,
        usage: `chromium.connectOverCDP('${absoluteCdpUrl(ctx.baseUrl, id)}')`,
      });
    }
  );

  server.registerTool(
    'stop_profile',
    {
      title: 'Stop profile',
      description:
        'Gracefully stop a running profile. Its user-data directory is kept, so ' +
        'cookies and logins survive until the next launch.',
      inputSchema: idSchema,
    },
    async ({ id }) => {
      if (!mgr.running.has(id)) return fail(`Profile ${id} is not running.`);
      await mgr.stop(id);
      return ok({ ok: true, id });
    }
  );

  server.registerTool(
    'force_stop_profile',
    {
      title: 'Force-stop profile',
      description:
        'Escape hatch for a wedged session: drops the tracking entry and tears down ' +
        'the display without waiting on the browser. Use when stop_profile hangs or ' +
        'a profile reports running but its CDP endpoint is dead (alive: false).',
      inputSchema: idSchema,
    },
    async ({ id }) => {
      if (!mgr.running.has(id)) return fail(`Profile ${id} is not running.`);
      mgr.evict(id);
      return ok({ ok: true, id });
    }
  );

  // ── Observability ─────────────────────────────────────────────────────────

  server.registerTool(
    'take_screenshot',
    {
      title: 'Take screenshot',
      description:
        'JPEG screenshot of the profile\'s current page. Captured live when the ' +
        'profile is running, otherwise the last cached image is returned. Use it to ' +
        'see what state a browser is actually in.',
      inputSchema: idSchema,
    },
    async ({ id }) => {
      if (!db.getProfile(id)) return fail(`No profile with id ${id}.`);

      const shot = await getScreenshot(id, mgr.running.get(id));
      if (!shot) {
        return fail(
          `No screenshot available for ${id} — it has never been captured. Launch it first.`
        );
      }

      return {
        content: [
          { type: 'image' as const, data: shot.bytes.toString('base64'), mimeType: 'image/jpeg' },
          {
            type: 'text' as const,
            text: shot.cached
              ? 'Cached image from when this profile last ran — not live.'
              : 'Live capture.',
          },
        ],
      };
    }
  );

  server.registerTool(
    'test_proxy',
    {
      title: 'Test proxy',
      description:
        'Check a proxy URL before assigning it to a profile: reports whether it ' +
        'connects, its exit IP and latency. Never throws — a dead proxy is a ' +
        'successful test with ok: false.',
      inputSchema: proxyTestRequestSchema.shape,
    },
    async ({ proxy }) => ok(await testProxy(proxy))
  );

  return server;
}
