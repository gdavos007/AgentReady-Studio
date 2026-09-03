import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Serves the Phase 1 mock storefront fixture.
 *
 * The studio hosts its own verified audit target so a local install can produce
 * a real report — registered WebMCP tools, declarative markup, seeded friction
 * traps and all — with no outbound network access. `next.config.ts` rewrites
 * `/.well-known/*` and `/llms.txt` to the sibling routes, so the fixture's
 * descriptors resolve against this same origin.
 */
export async function GET(): Promise<Response> {
  try {
    const html = await readFile(join(process.cwd(), 'tests', 'fixtures', 'mock-site.html'), 'utf8');
    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  } catch (error) {
    return new Response(`Fixture unavailable: ${error instanceof Error ? error.message : String(error)}`, {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
}
