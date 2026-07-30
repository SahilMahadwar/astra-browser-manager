/**
 * Streamable HTTP transport for the MCP server, mounted on the main Hono app.
 *
 * The SDK's WebStandardStreamableHTTPServerTransport speaks Request/Response, so
 * it plugs straight into Hono with `c.req.raw` — no Node req/res adapter needed.
 *
 * A fresh McpServer + transport per request: the tool surface is stateless, and
 * the base URL handed to the tools is derived from the request itself, so there
 * is nothing worth keeping between calls. Registering a dozen tools costs
 * microseconds next to launching a browser.
 */

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Context, Hono } from 'hono';

import { isHttps } from './../auth.js';
import { buildMcpServer } from './server.js';
import { logger } from './../logger.js';
import type { BrowserManager } from './../browser.js';

const log = logger('mcp');

export const MCP_PATH = '/mcp';

/**
 * Where an MCP client should reach this server.
 *
 * The Host header is right for the common case (agent talks to the same URL a
 * human would), but a container behind a reverse proxy that rewrites Host — or
 * one reached over a different scheme — needs the override. The CDP URLs handed
 * to agents are built from this, so getting it wrong means the agent connects
 * to the wrong place.
 */
export function resolveBaseUrl(c: Context): string {
  const override = process.env.PUBLIC_BASE_URL;
  if (override) return override.replace(/\/+$/, '');

  const host = c.req.header('host') ?? 'localhost:8080';
  return `${isHttps(c) ? 'https' : 'http'}://${host}`;
}

export function mountMcp(app: Hono, mgr: BrowserManager): void {
  app.all(MCP_PATH, async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: nothing here is session-scoped
      enableJsonResponse: true, // plain JSON replies; no SSE stream to keep alive
    });
    const server = buildMcpServer(mgr, { baseUrl: resolveBaseUrl(c) });

    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } catch (err) {
      log.error(`MCP request failed: ${String(err)}`);
      return c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        },
        500
      );
    } finally {
      await server.close();
    }
  });
}
