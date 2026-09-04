/**
 * Security regression tests for Batch 2 — the resource-exhaustion and
 * output-integrity findings (M1–M4, L1).
 *
 * Each block is the proof of concept for its finding, kept as a test so the
 * fix cannot be quietly undone: an unbounded descriptor, an unbounded
 * document, a saturated studio, a scan that outlives its budget, and a target
 * that writes markdown into someone else's pull request.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { GET as getAudit, POST as postAudit } from '../app/api/audit/route.js';
import {
  DEFAULT_MAX_CONCURRENT,
  MAX_CONCURRENT_ENV,
  TOKEN_ENV,
  acquireAuditSlot,
  authRequired,
  inFlightAudits,
  isAuthorised,
  maxConcurrent,
  resetAuditSlots,
} from '../src/lib/api-guard.js';
import {
  parseContentLength,
  probeDescriptor,
  type FetchLike,
} from '../src/scanner/declarative-discovery.js';
import {
  DEFAULT_OPTIONS,
  MAX_SERVED_HTML_CHARS,
  launchArgs,
  scanUrl,
} from '../src/scanner/engine.js';
import { MAX_DESCRIPTOR_BYTES, MAX_DESCRIPTOR_TRANSFER_BYTES } from '../src/scanner/types.js';
import { formatMarkdown } from '../packages/cli/src/formatters/markdown.js';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: launchArgs(true) });
}, 180_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
});

afterEach(() => {
  resetAuditSlots();
  delete process.env[TOKEN_ENV];
  delete process.env[MAX_CONCURRENT_ENV];
});

/* -------------------------------------------------------------------------- */
/* M1 — descriptor download ceiling                                            */
/* -------------------------------------------------------------------------- */

/** A `FetchLike` that answers with whatever the test dictates. */
function stubFetch(response: {
  status?: number;
  headers?: Record<string, string>;
  text?: string;
  stream?: () => AsyncIterable<Uint8Array>;
  onText?: () => void;
}): FetchLike {
  return {
    async get() {
      return {
        status: () => response.status ?? 200,
        headers: () => ({ 'content-type': 'application/json', ...(response.headers ?? {}) }),
        async text() {
          response.onText?.();
          return response.text ?? '';
        },
        ...(response.stream ? { stream: response.stream } : {}),
      };
    },
  };
}

const DESCRIPTOR = { kind: 'well-known-mcp' as const, path: '/.well-known/mcp', alternates: [] };

describe('M1 — descriptor transfer ceiling', () => {
  it('reads content-length only when it is a plain integer', () => {
    expect(parseContentLength({ 'content-length': '1024' })).toBe(1024);
    expect(parseContentLength({ 'content-length': '  1024  ' })).toBe(1024);
    // A duplicated header, an exponent, and a negative are all "unknown",
    // never "small" — the whole point is to refuse before the body arrives.
    expect(parseContentLength({ 'content-length': '100, 100' })).toBeNull();
    expect(parseContentLength({ 'content-length': '1e9' })).toBeNull();
    expect(parseContentLength({ 'content-length': '-1' })).toBeNull();
    expect(parseContentLength({})).toBeNull();
  });

  it('refuses an oversized descriptor without reading the body', async () => {
    let bodyWasRead = false;
    const request = stubFetch({
      headers: { 'content-length': String(MAX_DESCRIPTOR_TRANSFER_BYTES + 1) },
      text: 'x'.repeat(10),
      onText: () => {
        bodyWasRead = true;
      },
    });

    const probe = await probeDescriptor(request, 'https://target.test', DESCRIPTOR, 1_000);

    expect(probe.oversized).toBe(true);
    expect(probe.found).toBe(false);
    expect(probe.body).toBeNull();
    expect(probe.error).toMatch(/ceiling/i);
    expect(bodyWasRead).toBe(false);
  });

  it('stops reading a chunked body at the ceiling', async () => {
    // No content-length — the case a header check cannot see. This server
    // intends to stream forever.
    let chunksYielded = 0;
    const request = stubFetch({
      headers: {},
      stream: async function* () {
        for (;;) {
          chunksYielded += 1;
          yield new Uint8Array(64_000);
        }
      },
    });

    const probe = await probeDescriptor(request, 'https://target.test', DESCRIPTOR, 1_000);

    expect(probe.oversized).toBe(true);
    expect(probe.body).toBeNull();
    // Bounded, not endless: just enough chunks to cross the ceiling.
    expect(chunksYielded).toBeLessThanOrEqual(Math.ceil(MAX_DESCRIPTOR_TRANSFER_BYTES / 64_000) + 1);
  });

  it('still accepts a descriptor that fits', async () => {
    const payload = JSON.stringify({ tools: [{ name: 'search', description: 'Search.' }] });
    const probe = await probeDescriptor(
      stubFetch({ headers: { 'content-length': String(payload.length) }, text: payload }),
      'https://target.test',
      DESCRIPTOR,
      1_000,
    );

    expect(probe.oversized).toBeFalsy();
    expect(probe.found).toBe(true);
    expect(probe.json).not.toBeNull();
  });

  it('truncates a large-but-permitted body to the retention cap', async () => {
    // Between the retention cap and the transfer ceiling: read in full,
    // retained in part.
    const payload = `{"tools":[],"padding":"${'p'.repeat(MAX_DESCRIPTOR_BYTES)}"}`;
    expect(payload.length).toBeGreaterThan(MAX_DESCRIPTOR_BYTES);
    expect(payload.length).toBeLessThan(MAX_DESCRIPTOR_TRANSFER_BYTES);

    const probe = await probeDescriptor(
      stubFetch({ headers: {}, text: payload }),
      'https://target.test',
      DESCRIPTOR,
      1_000,
    );

    expect(probe.oversized).toBeFalsy();
    expect(probe.byteLength).toBe(payload.length);
    expect(probe.body?.length).toBe(MAX_DESCRIPTOR_BYTES);
  });
});

/* -------------------------------------------------------------------------- */
/* M2 — studio admission control                                               */
/* -------------------------------------------------------------------------- */

/** A well-formed audit request, so the guard under test is what rejects it. */
function auditRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://studio.test/api/audit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ url: 'https://example.com' }),
  });
}

describe('M2 — concurrency semaphore', () => {
  it('defaults to two slots and hands out no more', () => {
    expect(maxConcurrent()).toBe(DEFAULT_MAX_CONCURRENT);

    const first = acquireAuditSlot();
    const second = acquireAuditSlot();
    const third = acquireAuditSlot();

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(third).toBeNull();
    expect(inFlightAudits()).toBe(DEFAULT_MAX_CONCURRENT);

    first?.release();
    expect(acquireAuditSlot()).not.toBeNull();
  });

  it('ignores a double release, so a slot cannot be conjured from nothing', () => {
    const slot = acquireAuditSlot();
    slot?.release();
    slot?.release();
    slot?.release();
    expect(inFlightAudits()).toBe(0);

    expect(acquireAuditSlot()).not.toBeNull();
    expect(acquireAuditSlot()).not.toBeNull();
    expect(acquireAuditSlot()).toBeNull();
  });

  it('honours AGENTGRADE_MAX_CONCURRENT within sane bounds', () => {
    process.env[MAX_CONCURRENT_ENV] = '4';
    expect(maxConcurrent()).toBe(4);

    // Garbage and absurd values fall back rather than disabling the limit.
    process.env[MAX_CONCURRENT_ENV] = '0';
    expect(maxConcurrent()).toBe(DEFAULT_MAX_CONCURRENT);
    process.env[MAX_CONCURRENT_ENV] = 'unlimited';
    expect(maxConcurrent()).toBe(DEFAULT_MAX_CONCURRENT);
    process.env[MAX_CONCURRENT_ENV] = '9999';
    expect(maxConcurrent()).toBe(16);
  });

  it('holds the slot until the audit finishes, not until the stream is read', async () => {
    // The bypass this closes: open a request, drop the connection, repeat.
    // The pipeline deliberately keeps running after a client disconnects, so a
    // slot released when the reader goes away would free it while the browser
    // is still open — and the limit would bound nothing.
    let settled: (() => void) | undefined;
    const audit = new Promise<void>((resolve) => {
      settled = resolve;
    });

    const slot = acquireAuditSlot();
    expect(slot).not.toBeNull();

    // A reader that goes away changes nothing while the audit is in flight.
    expect(inFlightAudits()).toBe(1);
    await Promise.resolve();
    expect(inFlightAudits()).toBe(1);

    // Only the audit's own completion returns it.
    slot?.release();
    settled?.();
    await audit;
    expect(inFlightAudits()).toBe(0);
  });

  it('answers 429 with Retry-After once saturated', async () => {
    acquireAuditSlot();
    acquireAuditSlot();

    const response = await postAudit(auditRequest());

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toMatch(/already running/i);
  });
});

describe('M2 — bearer token', () => {
  it('is off until AGENTGRADE_TOKEN is set', () => {
    expect(authRequired()).toBe(false);
    expect(isAuthorised(auditRequest())).toBe(true);
  });

  it('rejects a missing, malformed, or wrong token once configured', async () => {
    process.env[TOKEN_ENV] = 'correct-horse-battery-staple';
    expect(authRequired()).toBe(true);

    expect(isAuthorised(auditRequest())).toBe(false);
    expect(isAuthorised(auditRequest({ authorization: 'correct-horse-battery-staple' }))).toBe(false);
    expect(isAuthorised(auditRequest({ authorization: 'Bearer wrong' }))).toBe(false);
    // A prefix of the real token must not pass.
    expect(isAuthorised(auditRequest({ authorization: 'Bearer correct-horse' }))).toBe(false);

    const response = await postAudit(auditRequest());
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toMatch(/^Bearer/);
    // Rejected before the body was parsed and before a slot was taken.
    expect(inFlightAudits()).toBe(0);
  });

  it('accepts the configured token, case-insensitively on the scheme', () => {
    process.env[TOKEN_ENV] = 'sekrit';
    expect(isAuthorised(auditRequest({ authorization: 'Bearer sekrit' }))).toBe(true);
    expect(isAuthorised(auditRequest({ authorization: 'bearer sekrit' }))).toBe(true);
  });

  it('closes the report listing behind the same token', async () => {
    process.env[TOKEN_ENV] = 'sekrit';

    const anonymous = await getAudit(new Request('http://studio.test/api/audit?limit=5'));
    expect(anonymous.status).toBe(401);

    const authorised = await getAudit(
      new Request('http://studio.test/api/audit?limit=5', {
        headers: { authorization: 'Bearer sekrit' },
      }),
    );
    expect(authorised.status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/* M3 — CSP and TLS defaults                                                   */
/* -------------------------------------------------------------------------- */

describe('M3 — isolation defaults', () => {
  it('leaves CSP and certificate validation in force by default', () => {
    expect(DEFAULT_OPTIONS.bypassCsp).toBe(false);
    expect(DEFAULT_OPTIONS.ignoreHttpsErrors).toBe(false);
  });

  it('records a warning in the report when either is switched off', async () => {
    const report = await scanUrl('https://example.invalid/', {
      browser: browser as never,
      bypassCsp: true,
      ignoreHttpsErrors: true,
      navigationTimeoutMs: 2_000,
      totalTimeoutMs: 8_000,
      skipDescriptors: true,
    });

    const codes = report.data.diagnostics.map((entry) => entry.code);
    expect(codes).toContain('csp-bypassed');
    expect(codes).toContain('tls-errors-ignored');
  }, 60_000);

  it('records neither warning on a normal scan', async () => {
    const report = await scanUrl('https://example.invalid/', {
      browser: browser as never,
      navigationTimeoutMs: 2_000,
      totalTimeoutMs: 8_000,
      skipDescriptors: true,
    });

    const codes = report.data.diagnostics.map((entry) => entry.code);
    expect(codes).not.toContain('csp-bypassed');
    expect(codes).not.toContain('tls-errors-ignored');
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/* M4 — execution budget and document caps                                     */
/* -------------------------------------------------------------------------- */

describe('M4 — execution budget', () => {
  it('returns within the total budget even when every stage stalls', async () => {
    // Never finishes loading: the response stays open, so `goto`, the settle
    // wait, and network-idle would each run to their own 30s timeout.
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.write('<!doctype html><html><head><title>Stall</title></head><body>');
      // Deliberately never ended.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const budget = 6_000;
    const startedAt = Date.now();
    try {
      const report = await scanUrl(`http://127.0.0.1:${port}/`, {
        browser: browser as never,
        totalTimeoutMs: budget,
        // Each of these alone would outlast the budget several times over.
        navigationTimeoutMs: 30_000,
        networkIdleTimeoutMs: 30_000,
        modelContextTimeoutMs: 30_000,
        skipDescriptors: true,
      });
      const elapsed = Date.now() - startedAt;

      // Generous headroom for teardown, but nowhere near the 30s a single
      // stage was allowed on its own — let alone their sum.
      expect(elapsed).toBeLessThan(budget + 12_000);
      expect(report.data.scanId).toBeTruthy();
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 90_000);

  it('caps the HTML it pulls out of a page that inflates its own DOM', async () => {
    // ~24 MB of markup generated in the renderer, so it never crosses the
    // wire and no download limit would catch it. Before the cap, all of it
    // arrived in this process as one string.
    const html = [
      '<!doctype html><html><head><title>Fat</title></head><body>',
      '<script>',
      "  const blob = 'z'.repeat(1000);",
      '  for (let i = 0; i < 24000; i += 1) {',
      "    const node = document.createElement('div');",
      '    node.textContent = blob;',
      '    document.body.appendChild(node);',
      '  }',
      '</script></body></html>',
    ].join('\n');

    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const report = await scanUrl(`http://127.0.0.1:${port}/`, {
        browser: browser as never,
        totalTimeoutMs: 45_000,
        navigationTimeoutMs: 20_000,
        skipDescriptors: true,
      });

      // The scan still produced a report; it just did not swallow the
      // document, and it said so rather than truncating silently.
      expect(report.data.scanId).toBeTruthy();
      const truncation = report.data.diagnostics.find(
        (entry) => entry.code === 'served-html-truncated',
      );
      expect(truncation).toBeDefined();
      expect(truncation?.message).toContain(String(MAX_SERVED_HTML_CHARS));
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 90_000);

  it('leaves an ordinary page untruncated', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><head><title>Small</title></head><body><p>Hi</p></body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const report = await scanUrl(`http://127.0.0.1:${port}/`, {
        browser: browser as never,
        totalTimeoutMs: 20_000,
        skipDescriptors: true,
      });
      expect(report.data.diagnostics.map((entry) => entry.code)).not.toContain(
        'served-html-truncated',
      );
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/* L1 — PR comment integrity                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A run result whose target-controlled strings are hostile.
 *
 * Only the fields the markdown formatter reads are populated; the rest is cast
 * away rather than reconstructing a whole scorecard for a formatting test.
 */
function hostileResult(overrides: {
  issueTitle?: string;
  remediation?: string;
  url?: string;
  headline?: string;
}): Parameters<typeof formatMarkdown>[0] {
  return {
    url: overrides.url ?? 'https://target.test/',
    threshold: 80,
    passed: false,
    durationMs: 1234,
    report: { data: {} },
    scorecard: {
      grade: 'F',
      overallScore: 20,
      pillars: [{ id: 'discovery', label: 'Discovery', weightedPoints: 1, maxPoints: 20 }],
      issues: [
        {
          id: 'x',
          severity: 'critical',
          title: overrides.issueTitle ?? 'A problem',
          remediation: overrides.remediation ?? 'Fix it.',
          deductionPoints: 0,
          pillar: 'discovery',
          impactDescription: '',
          evidence: {},
          relatedSelectors: [],
          componentId: null,
        },
      ],
      benchmark: {
        goal: 'Buy something',
        pricing: { model: 'test-model' },
        domTraversal: { steps: 10, totalTokens: 100, costUsd: 1, latencyMs: 1000, failureProbability: 0.1 },
        webMcpDirect: { steps: 1, totalTokens: 10, costUsd: 0.1, latencyMs: 100, failureProbability: 0.01 },
        frictionTax: {
          headline: overrides.headline ?? 'Saves money.',
          tokensWasted: 90,
          costWastedUsd: 0.9,
          secondsWasted: 0.9,
          failureProbabilityDelta: 0.09,
        },
      },
    },
  } as unknown as Parameters<typeof formatMarkdown>[0];
}

describe('L1 — markdown injection from an audited target', () => {
  it('keeps a pipe in a field name from forging table columns', () => {
    const body = formatMarkdown(hostileResult({ issueTitle: 'Field | evil | 999 | pwned' }), {
      includeRemediation: false,
    });

    const row = body.split('\n').find((line) => line.includes('evil'));
    expect(row).toBeDefined();
    expect(row).toContain('\\|');
    // Still one data row's worth of unescaped delimiters, not five.
    expect((row?.match(/(?<!\\)\|/g) ?? []).length).toBe(5);
  });

  it('neutralises a code-fence break-out on a standalone line', () => {
    // The headline is emitted on a line of its own, where a fence is a block
    // construct that would swallow the rest of the comment.
    const body = formatMarkdown(
      hostileResult({ headline: '```\n## Injected heading\n<img src=x onerror=alert(1)>\n```' }),
      { includeRemediation: false },
    );

    expect(body).not.toContain('```');
    // The heading marker is no longer at the start of a line, and the tag is
    // no longer a tag.
    expect(body).not.toMatch(/^## Injected heading$/m);
    expect(body).not.toContain('<img');
    expect(body).toContain('&lt;img');
  });

  it('escapes HTML in a table cell rather than trusting GitHub to strip it', () => {
    const body = formatMarkdown(
      hostileResult({ remediation: '<img src=x onerror=alert(1)>' }),
      { includeRemediation: false },
    );

    expect(body).not.toContain('<img');
    expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('keeps legitimate inline code in a remediation string', () => {
    // Real remediation text quotes attribute names; mangling those would make
    // the comment worse to read for every honest target.
    const body = formatMarkdown(
      hostileResult({ remediation: 'Annotate the form with `data-mcp-tool`.' }),
      { includeRemediation: false },
    );

    expect(body).toContain('`data-mcp-tool`');
  });

  it('strips control characters and newlines that would end a row early', () => {
    const body = formatMarkdown(
      hostileResult({ issueTitle: 'line one\nline two\r\nline three  end' }),
      { includeRemediation: false },
    );

    const row = body.split('\n').find((line) => line.includes('line one'));
    expect(row).toBeDefined();
    // All three fragments survive on one row, the control characters do not.
    expect(row).toContain('line two');
    expect(row).toContain('line three');
    expect(row).not.toContain('');
    expect(row).not.toContain(' ');
  });

  it('caps a single cell so one issue cannot crowd out the report', () => {
    const body = formatMarkdown(hostileResult({ remediation: 'A'.repeat(50_000) }), {
      includeRemediation: false,
    });

    expect(body).not.toContain('A'.repeat(1_000));
    expect(body).toContain('…');
  });

  it('keeps the whole comment inside GitHub’s length limit', () => {
    const body = formatMarkdown(
      hostileResult({
        issueTitle: 'B'.repeat(200_000),
        remediation: 'C'.repeat(200_000),
        headline: 'D'.repeat(200_000),
      }),
      { includeRemediation: false },
    );

    expect(body.length).toBeLessThanOrEqual(65_000);
  });

  it('leaves an ordinary report unmangled', () => {
    const body = formatMarkdown(
      hostileResult({
        issueTitle: 'Back the search surface with a WebMCP tool',
        remediation: 'Register a tool with a typed input schema.',
      }),
      { includeRemediation: false },
    );

    expect(body).toContain('Back the search surface with a WebMCP tool');
    expect(body).toContain('Register a tool with a typed input schema.');
    expect(body).toContain('<!-- agentgrade-report -->');
    expect(body).toContain('https://target.test/');
  });
});
