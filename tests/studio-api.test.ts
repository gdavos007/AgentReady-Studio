/**
 * Tests for the studio's storage, pipeline, and API routes.
 *
 * The audit route is exercised end to end — a real Chromium scan of the Phase 1
 * fixture, streamed as NDJSON through the actual route handler — because the
 * thing most likely to break is the seam between the Next runtime and the
 * Playwright-backed pipeline, and only running it proves that seam holds.
 */

import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GET as getReports, DELETE as deleteReport } from '../app/api/reports/route.js';
import { POST as postAudit, GET as getAuditList } from '../app/api/audit/route.js';
import { runAuditPipeline } from '../src/lib/pipeline.js';
import { AUDIT_STAGES, STAGE_LABELS } from '../src/lib/stages.js';
import { openReportStore, type ReportStore } from '../src/lib/store.js';
import { validateAgentAuditRawData } from '../src/scanner/validation.js';
import { startFixtureServer, type FixtureServer } from './helpers/fixture-server.js';
import { makeStudioFixture } from './helpers/studio-fixture.js';

let server: FixtureServer;
let browser: Browser;

beforeAll(async () => {
  server = await startFixtureServer();
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
}, 180_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await server?.close();
});

/** Reads an NDJSON body into parsed events. */
async function readNdjson(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/* -------------------------------------------------------------------------- */

describe('report store', () => {
  let store: ReportStore;

  beforeAll(() => {
    store = openReportStore(':memory:');
  });

  afterAll(() => store.close());

  it('round-trips a scorecard through SQLite without loss', async () => {
    const fixture = await makeStudioFixture();
    const saved = store.save({
      id: 'store-test-1',
      url: 'https://example.test/',
      status: 'ok',
      grade: fixture.scorecard.grade,
      score: fixture.scorecard.overallScore,
      report: { status: 'ok', generatedAt: '2026-01-01T00:00:00.000Z', durationMs: 1, data: fixture.data },
      scorecard: fixture.scorecard,
    });

    expect(saved.createdAt).toBeTruthy();
    const loaded = store.get('store-test-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.scorecard).toEqual(fixture.scorecard);
    expect(loaded!.report.data).toEqual(fixture.data);
    expect(validateAgentAuditRawData(loaded!.report.data).errors).toEqual([]);
  });

  it('lists newest first and deletes by id', async () => {
    // The previous test saved a row with a wall-clock timestamp, so start clean
    // and control every `createdAt` the ordering assertion depends on.
    store.clear();
    const fixture = await makeStudioFixture();
    const base = {
      url: 'https://example.test/',
      status: 'ok' as const,
      grade: fixture.scorecard.grade,
      score: fixture.scorecard.overallScore,
      report: { status: 'ok' as const, generatedAt: '2026-01-01T00:00:00.000Z', durationMs: 1, data: fixture.data },
      scorecard: fixture.scorecard,
    };
    store.save({ ...base, id: 'older', createdAt: '2026-01-01T00:00:00.000Z' });
    store.save({ ...base, id: 'newer', createdAt: '2026-06-01T00:00:00.000Z' });

    const listed = store.list(10);
    expect(listed[0].id).toBe('newer');
    expect(listed.map((entry) => entry.id)).toContain('older');
    expect(listed[0].issueCount).toBe(fixture.scorecard.issues.length);

    expect(store.delete('older')).toBe(true);
    expect(store.delete('older')).toBe(false);
    expect(store.get('older')).toBeNull();
  });

  it('reports which backend is in use', () => {
    // node:sqlite ships with Node 22.5+; anything older degrades to memory.
    expect(['sqlite', 'memory']).toContain(store.backend);
  });
});

/* -------------------------------------------------------------------------- */

describe('runAuditPipeline', () => {
  it('scans, scores, persists, and reports every stage in order', async () => {
    const store = openReportStore(':memory:');
    const stages: string[] = [];

    try {
      const stored = await runAuditPipeline(server.url('/'), {
        id: 'pipeline-test-1',
        store,
        syntheticGoal: 'Execute product search',
        scanner: { browser: browser as never },
        onProgress: (event) => {
          stages.push(event.stage);
          expect(event.label).toBe(STAGE_LABELS[event.stage]);
          expect(event.progress).toBeGreaterThan(0);
          expect(event.progress).toBeLessThanOrEqual(1);
          expect(event.detail.length).toBeGreaterThan(0);
        },
      });

      // Stages arrive in the declared order, with no regressions.
      const order = AUDIT_STAGES.map(String);
      const seen = stages.filter((stage, index) => stages.indexOf(stage) === index);
      expect(seen).toEqual(order.filter((stage) => seen.includes(stage)));
      expect(seen).toContain('discovery');
      expect(seen).toContain('surfaces');
      expect(seen).toContain('traps');
      expect(seen).toContain('benchmark');
      expect(seen.at(-1)).toBe('complete');

      expect(stored.id).toBe('pipeline-test-1');
      expect(stored.report.data.tools.length).toBeGreaterThan(0);
      expect(stored.scorecard.overallScore).toBeGreaterThanOrEqual(0);
      expect(stored.scorecard.overallScore).toBeLessThanOrEqual(100);
      expect(stored.scorecard.syntheticEvaluation?.attempts[0]?.toolName).toBe('search_products');
      expect(store.get('pipeline-test-1')?.scorecard.grade).toBe(stored.grade);
    } finally {
      store.close();
    }
  }, 180_000);

  it('persists a scored report even for a target that fails to load', async () => {
    const store = openReportStore(':memory:');
    try {
      const stored = await runAuditPipeline('http://127.0.0.1:1/', {
        id: 'pipeline-dead',
        store,
        scanner: { browser: browser as never, navigationTimeoutMs: 4_000 },
      });
      expect(stored.report.status).toBe('failed');
      expect(stored.scorecard.overallScore).toBeGreaterThanOrEqual(0);
      expect(store.get('pipeline-dead')).not.toBeNull();
    } finally {
      store.close();
    }
  }, 120_000);
});

/* -------------------------------------------------------------------------- */

describe('POST /api/audit', () => {
  it('streams NDJSON progress and finishes with a report id', async () => {
    const response = await postAudit(
      new Request('http://studio.test/api/audit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: server.url('/'), syntheticGoal: 'Execute product search' }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    expect(response.headers.get('cache-control')).toContain('no-store');

    const events = await readNdjson(response);
    expect(events.length).toBeGreaterThan(3);

    const complete = events.at(-1)!;
    expect(complete.stage).toBe('complete');
    expect(typeof complete.reportId).toBe('string');
    expect(['A', 'B', 'C', 'D', 'F']).toContain(complete.grade);
    expect(complete.score).toBeGreaterThanOrEqual(0);

    // The finished report is retrievable from the shared store.
    const listResponse = await getAuditList(new Request('http://studio.test/api/audit?limit=5'));
    const listed = (await listResponse.json()) as { reports: Array<{ id: string }> };
    expect(listed.reports.some((entry) => entry.id === complete.reportId)).toBe(true);
  }, 240_000);

  it('rejects a malformed body', async () => {
    const response = await postAudit(
      new Request('http://studio.test/api/audit', { method: 'POST', body: 'not json' }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('JSON');
  });

  it('rejects a missing or unparseable url', async () => {
    for (const body of [{}, { url: '   ' }, { url: 'http://' }]) {
      const response = await postAudit(
        new Request('http://studio.test/api/audit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(400);
    }
  });

  it('refuses non-http protocols so the studio cannot read the filesystem', async () => {
    const response = await postAudit(
      new Request('http://studio.test/api/audit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'file:///etc/passwd' }),
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('http');
  });

  it('defaults a bare hostname to https', async () => {
    // Reaching the network is not the point; the 400 boundary is.
    const response = await postAudit(
      new Request('http://studio.test/api/audit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'example.com', navigationTimeoutMs: 1 }),
      }),
    );
    expect(response.status).toBe(200);
    const events = await readNdjson(response);
    expect(events.at(-1)!.stage).toBe('complete');
  }, 120_000);
});

/* -------------------------------------------------------------------------- */

describe('/api/reports', () => {
  it('lists stored reports and names the backend', async () => {
    const response = await getReports(new Request('http://studio.test/api/reports?limit=3'));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { backend: string; reports: unknown[] };
    expect(['sqlite', 'memory']).toContain(payload.backend);
    expect(Array.isArray(payload.reports)).toBe(true);
  });

  it('requires an id to delete, and 404s an unknown one', async () => {
    const missingId = await deleteReport(new Request('http://studio.test/api/reports', { method: 'DELETE' }));
    expect(missingId.status).toBe(400);

    const unknown = await deleteReport(
      new Request('http://studio.test/api/reports?id=does-not-exist', { method: 'DELETE' }),
    );
    expect(unknown.status).toBe(404);
  });
});
