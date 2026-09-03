/**
 * A loopback HTTP server that serves the scanner fixtures plus the well-known
 * agent descriptors, so the engine can be exercised end to end without leaving
 * the machine.
 */

import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** The `/.well-known/mcp` payload served by {@link startFixtureServer}. */
export const WELL_KNOWN_MCP = {
  schemaVersion: '2025-06-18',
  name: 'nimbus-outfitters',
  tools: [
    {
      name: 'get_order_status',
      description: 'Return the fulfilment status of a customer order.',
      inputSchema: {
        type: 'object',
        properties: { orderId: { type: 'string' }, email: { type: 'string' } },
        required: ['orderId'],
      },
    },
    {
      name: 'start_return',
      description: 'Open a return request for a delivered order line.',
      inputSchema: { type: 'object', properties: { orderId: { type: 'string' }, sku: { type: 'string' } } },
    },
  ],
};

/** The `/.well-known/agent.json` payload served by {@link startFixtureServer}. */
export const WELL_KNOWN_AGENT = {
  name: 'Nimbus Shopping Agent',
  description: 'Agent card for the Nimbus Outfitters storefront.',
  url: 'https://nimbus.example/agent',
  skills: [
    { id: 'browse', name: 'browse_catalog', description: 'Browse the product catalog.' },
    { id: 'support', name: 'contact_support', description: 'Open a support conversation.' },
  ],
};

/** The `/llms.txt` payload served by {@link startFixtureServer}. */
export const LLMS_TXT = `# Nimbus Outfitters

> Outdoor gear retailer.

## Capabilities

- [Product search](/api/search): Search the catalog by keyword.
- [Order tracking](/api/orders): Look up an order by confirmation number.
`;

/** Options accepted by {@link startFixtureServer}. */
export interface FixtureServerOptions {
  /**
   * When true, every `/.well-known/*` and `/llms.txt` path answers `200 OK`
   * with an HTML shell instead of a descriptor — the "soft 404" behaviour of
   * SPA hosts that route unknown paths to `index.html`.
   */
  softDescriptors?: boolean;
}

/** A running fixture server. */
export interface FixtureServer {
  /** Base origin, e.g. `http://127.0.0.1:53124`. */
  origin: string;
  /** Resolves an absolute URL for a path on this server. */
  url(path: string): string;
  close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveFixture(response: ServerResponse, fileName: string, status = 200): Promise<void> {
  try {
    const body = await readFile(join(FIXTURE_DIR, fileName));
    const extension = fileName.slice(fileName.lastIndexOf('.'));
    response.writeHead(status, { 'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream' });
    response.end(body);
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end(String(error));
  }
}

function sendJson(response: ServerResponse, payload: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

/**
 * Starts the fixture server on an ephemeral loopback port.
 *
 * Routes:
 * - `/`                      the full fixture store page
 * - `/bare`                  a page with no agent surface at all
 * - `/embed.html`            iframe target
 * - `/.well-known/mcp`       MCP tool manifest
 * - `/.well-known/agent.json` agent card
 * - `/llms.txt`              markdown capability listing
 * - `/soft-404`              200 OK HTML shell (tests soft-404 rejection)
 * - `/blocked`               403 + captcha markup (tests bot-wall detection)
 * - `/missing`               404
 * - `/hang`                  never responds (tests navigation timeouts)
 */
export async function startFixtureServer(options: FixtureServerOptions = {}): Promise<FixtureServer> {
  const softDescriptors = options.softDescriptors ?? false;
  const softShell = '<!doctype html><html><body><div id="root"></div></body></html>';
  const openSockets = new Set<import('node:net').Socket>();

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = (request.url ?? '/').split('?')[0];

    if (softDescriptors && (path.startsWith('/.well-known/') || path === '/llms.txt')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(softShell);
      return;
    }

    switch (path) {
      case '/':
      case '/index.html':
        void serveFixture(response, 'mock-site.html');
        return;
      case '/bare':
      case '/bare.html':
        void serveFixture(response, 'bare-site.html');
        return;
      case '/embed.html':
        void serveFixture(response, 'embed.html');
        return;
      case '/.well-known/mcp':
      case '/.well-known/mcp.json':
        sendJson(response, WELL_KNOWN_MCP);
        return;
      case '/.well-known/agent.json':
        sendJson(response, WELL_KNOWN_AGENT);
        return;
      case '/llms.txt':
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(LLMS_TXT);
        return;
      case '/soft-404':
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><html><body>Not found</body></html>');
        return;
      case '/blocked':
        response.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
        response.end(
          '<!doctype html><html><head><title>Attention Required</title></head><body>' +
            '<h1>Please verify you are human</h1><div id="challenge-form" data-sitekey="abc"></div>' +
            '</body></html>',
        );
        return;
      case '/hang':
        // Deliberately never responds: exercises the navigation timeout path.
        return;
      default:
        response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><html><body>404</body></html>');
    }
  });

  server.on('connection', (socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    url: (path: string) => new URL(path, origin).toString(),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of openSockets) socket.destroy();
        openSockets.clear();
        server.close(() => resolve());
      }),
  };
}
