import { acquireAuditSlot, isAuthorised, maxConcurrent } from '@/src/lib/api-guard';
import { checkHost, privateTargetsAllowed } from '@/src/lib/net-guard';
import { streamAuditPipeline } from '@/src/lib/pipeline';
import { getReportStore } from '@/src/lib/store';

/** Playwright needs a real Node runtime and must never be bundled for edge. */
export const runtime = 'nodejs';
/** Every audit launches a browser, so nothing here is cacheable. */
export const dynamic = 'force-dynamic';
/** A cold Chromium launch plus navigation can exceed the default budget. */
export const maxDuration = 300;

/** Request body accepted by `POST /api/audit`. */
export interface AuditRequestBody {
  url: string;
  /** Goal for the synthetic evaluator. Omit to skip the active evaluation. */
  syntheticGoal?: string;
  /** Navigation timeout override, in ms. */
  navigationTimeoutMs?: number;
}

/**
 * Runs an audit and streams NDJSON progress.
 *
 * Each line is one JSON object: `AuditProgressEvent` while the pipeline runs,
 * then a terminal `{ stage: 'complete', reportId }` or `{ stage: 'failed' }`.
 * A client that disconnects mid-run does not cancel the audit — the report is
 * still persisted and reachable at `/report/<id>`.
 */
export async function POST(request: Request): Promise<Response> {
  // Authentication first: an unauthenticated caller should learn nothing about
  // the target, not even whether it parsed.
  if (!isAuthorised(request)) {
    return jsonError('Missing or invalid bearer token.', 401, {
      'www-authenticate': 'Bearer realm="agentgrade"',
    });
  }

  let body: AuditRequestBody;
  try {
    body = (await request.json()) as AuditRequestBody;
  } catch {
    return jsonError('Request body must be JSON.', 400);
  }

  const url = typeof body?.url === 'string' ? body.url.trim() : '';
  if (!url) return jsonError('A "url" is required.', 400);

  const target = normaliseTarget(url);
  if (!target.ok) return jsonError(target.error, 400);

  // The network-facing boundary: anyone who can POST here would otherwise get a
  // full browser aimed at the host's internal network, and the rendered page's
  // title, headings and form structure all come back in the report. Checked by
  // resolved address, not hostname text.
  //
  // The studio's own sample target is `http://localhost:3000/api/fixture`, so
  // AGENTGRADE_ALLOW_PRIVATE_TARGETS=1 re-enables loopback for local use.
  if (!privateTargetsAllowed()) {
    const verdict = await checkHost(new URL(target.url).hostname);
    if (!verdict.allowed) {
      return jsonError(
        `${verdict.reason} Set AGENTGRADE_ALLOW_PRIVATE_TARGETS=1 to scan local and internal targets.`,
        403,
      );
    }
  }

  // Every audit past this point holds a browser for as long as it runs, so the
  // slot is taken before the pipeline starts and released when the stream ends
  // — not when this function returns, which happens immediately.
  const slot = acquireAuditSlot();
  if (!slot) {
    return jsonError(
      `The studio is already running ${maxConcurrent()} audit(s). Each one holds a browser, so they are not queued. Retry shortly.`,
      429,
      { 'retry-after': '30' },
    );
  }

  let stream: ReadableStream<Uint8Array>;
  try {
    stream = streamAuditPipeline(target.url, {
      syntheticGoal: typeof body.syntheticGoal === 'string' ? body.syntheticGoal : undefined,
      scanner:
        typeof body.navigationTimeoutMs === 'number'
          ? { navigationTimeoutMs: body.navigationTimeoutMs }
          : undefined,
      // Released when the *audit* finishes, not when the stream is consumed.
      // A client that disconnects does not cancel the run, so releasing on
      // cancel would free the slot while the browser is still open — and a
      // caller that opens connections and drops them is exactly the shape of
      // request this limit exists to stop.
      onSettled: () => slot.release(),
    });
  } catch (error) {
    slot.release();
    throw error;
  }

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      // Tell any intermediary not to buffer, or progress arrives all at once.
      'x-accel-buffering': 'no',
    },
  });
}

/** Returns the most recent audits, newest first. */
export async function GET(request: Request): Promise<Response> {
  // The listing carries every URL this studio has scanned, which on a shared
  // deployment is a record of what its users are working on. It sits behind the
  // same token as the audit itself.
  if (!isAuthorised(request)) {
    return jsonError('Missing or invalid bearer token.', 401, {
      'www-authenticate': 'Bearer realm="agentgrade"',
    });
  }

  const limit = Number(new URL(request.url).searchParams.get('limit') ?? '20');
  const reports = getReportStore().list(Number.isFinite(limit) ? limit : 20);
  return Response.json({ reports });
}

/**
 * Validates and normalises the target.
 *
 * Only http(s) is accepted from the network-facing API: the scanner itself can
 * read `file://`, which would let a caller enumerate the host filesystem
 * through the studio.
 */
function normaliseTarget(input: string): { ok: true; url: string } | { ok: false; error: string } {
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: `"${input}" is not a valid URL.` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `Only http and https targets are supported (got "${parsed.protocol}").` };
  }
  return { ok: true, url: parsed.toString() };
}

function jsonError(message: string, status: number, headers?: Record<string, string>): Response {
  return Response.json({ error: message }, { status, headers });
}
