/**
 * Tests for the AgentGrade Phase 2 evaluation layer.
 *
 * Three concerns:
 *  1. The Phase 1 mock storefront scores consistently through the real pipeline.
 *  2. Degenerate inputs (no tools, many traps, empty scans) stay bounded and
 *     free of NaN.
 *  3. Issue deductions reconcile exactly against the score they explain.
 */

import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scanUrl } from '../src/scanner/engine.js';
import { validateAgentAuditRawData } from '../src/scanner/validation.js';
import type { AgentAuditRawData } from '../src/scanner/types.js';

import { estimateBenchmark, computeFrictionTax, costOf, schemaClarity } from '../src/evals/benchmark.js';
import { gradeFor, scoreAudit } from '../src/evals/scorer.js';
import {
  SimulatedDriver,
  buildDomPlan,
  runSyntheticEvaluation,
  satisfiesSchema,
  synthesizeArguments,
} from '../src/evals/synthetic-agent.js';
import { deriveSurfaceCoverage, classifyToolByLanguage, safeRatio } from '../src/evals/analysis.js';
import { DEFAULT_PRICING, PILLAR_WEIGHTS, type PillarId } from '../src/evals/types.js';

import { startFixtureServer, type FixtureServer } from './helpers/fixture-server.js';
import {
  findNonFiniteNumbers,
  makeAuditData,
  makeDescriptors,
  makeForm,
  makeTool,
  makeTrap,
  resetFactory,
} from './helpers/audit-factory.js';

const FIXED_CLOCK = () => new Date('2026-01-01T00:00:00.000Z');

let server: FixtureServer;
let browser: Browser;
let mockSiteData: AgentAuditRawData;

beforeAll(async () => {
  resetFactory();
  server = await startFixtureServer();
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const report = await scanUrl(server.url('/'), { browser: browser as never, totalTimeoutMs: 90_000 });
  expect(validateAgentAuditRawData(report.data).errors).toEqual([]);
  mockSiteData = report.data;
}, 180_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await server?.close();
});

/* -------------------------------------------------------------------------- */

describe('scoreAudit — Phase 1 mock storefront', () => {
  it('produces a bounded, reconciled scorecard', () => {
    const scorecard = scoreAudit(mockSiteData, { now: FIXED_CLOCK });

    expect(scorecard.schemaVersion).toBe('1.0.0');
    expect(scorecard.scorecardId).toBe(`scorecard_${mockSiteData.scanId}`);
    expect(scorecard.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(scorecard.overallScore).toBeGreaterThanOrEqual(0);
    expect(scorecard.overallScore).toBeLessThanOrEqual(100);
    expect(scorecard.grade).toBe(gradeFor(scorecard.overallScoreExact));
    expect(findNonFiniteNumbers(scorecard)).toEqual([]);
    expect(JSON.parse(JSON.stringify(scorecard))).toEqual(scorecard);
  });

  it('is deterministic across repeated runs', () => {
    const a = scoreAudit(mockSiteData, { now: FIXED_CLOCK });
    const b = scoreAudit(mockSiteData, { now: FIXED_CLOCK });
    expect(a).toEqual(b);
  });

  it('scores all four pillars with weights that sum to 1', () => {
    const scorecard = scoreAudit(mockSiteData, { now: FIXED_CLOCK });
    const order = scorecard.pillars.map((pillar) => pillar.pillar);
    expect(order).toEqual(['discovery', 'actionability', 'friction', 'safety']);

    const weightSum = scorecard.pillars.reduce((total, pillar) => total + pillar.weight, 0);
    expect(weightSum).toBeCloseTo(1, 10);
    expect(Object.values(PILLAR_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);

    for (const pillar of scorecard.pillars) {
      expect(pillar.rawScore).toBeGreaterThanOrEqual(0);
      expect(pillar.rawScore).toBeLessThanOrEqual(100);
      // Points are rounded to 4dp so the scorecard serialises stably.
      expect(pillar.weightedPoints).toBeCloseTo(pillar.rawScore * pillar.weight, 3);
      expect(pillar.lostPoints).toBeCloseTo(pillar.maxPoints - pillar.weightedPoints, 3);
      const possible = pillar.components.reduce((total, component) => total + component.possible, 0);
      expect(possible).toBe(100);
      for (const component of pillar.components) {
        expect(component.earned).toBeGreaterThanOrEqual(0);
        expect(component.earned).toBeLessThanOrEqual(component.possible);
      }
    }

    const composed = scorecard.pillars.reduce((total, pillar) => total + pillar.weightedPoints, 0);
    expect(composed).toBeCloseTo(scorecard.overallScoreExact, 3);
  });

  it('credits the discovery signals the fixture actually serves', () => {
    const scorecard = scoreAudit(mockSiteData, { now: FIXED_CLOCK });
    const discovery = scorecard.pillars.find((pillar) => pillar.pillar === 'discovery')!;
    const component = (id: string) => discovery.components.find((entry) => entry.id === id)!;

    // The fixture server serves all three descriptors.
    expect(component('llms-txt').earned).toBe(15);
    expect(component('well-known-mcp').earned).toBe(25);
    expect(component('well-known-agent').earned).toBe(15);
    expect(component('semantic-metadata').earned).toBeGreaterThan(15);
    expect(component('tool-description-clarity').earned).toBeGreaterThan(0);
    expect(discovery.rawScore).toBeGreaterThan(80);
  });

  it('penalises the seeded friction traps', () => {
    const scorecard = scoreAudit(mockSiteData, { now: FIXED_CLOCK });
    const friction = scorecard.pillars.find((pillar) => pillar.pillar === 'friction')!;
    const penalty = friction.components[0];

    expect(mockSiteData.frictionTraps.length).toBeGreaterThan(5);
    expect(penalty.evidence.trapCount).toBe(mockSiteData.frictionTraps.length);
    expect(Number(penalty.evidence.weightedPenalty)).toBeGreaterThan(0);
    expect(friction.rawScore).toBeLessThan(100);
  });

  it('identifies the checkout surface as uncovered by a tool', () => {
    const coverage = deriveSurfaceCoverage(mockSiteData);
    const checkout = coverage.find((entry) => entry.form.category === 'checkout');
    expect(checkout).toBeDefined();

    const search = coverage.find((entry) => entry.form.category === 'search');
    expect(search).toBeDefined();
    // `search_products` is registered, so the search surface is covered.
    expect(search!.domOnly).toBe(false);
    expect(search!.coveringTools.map((tool) => tool.name)).toContain('search_products');
  });

  it('reconciles every deduction against the score', () => {
    const scorecard = scoreAudit(mockSiteData, { now: FIXED_CLOCK });
    const deducted = scorecard.issues.reduce((total, issue) => total + issue.deductionPoints, 0);
    expect(deducted).toBeCloseTo(100 - scorecard.overallScoreExact, 3);

    for (const issue of scorecard.issues) {
      expect(issue.deductionPoints).toBeGreaterThanOrEqual(0);
      expect(issue.id.length).toBeGreaterThan(0);
      expect(issue.title.length).toBeGreaterThan(0);
      expect(issue.impactDescription.length).toBeGreaterThan(20);
      expect(issue.remediation.length).toBeGreaterThan(20);
      expect(['critical', 'warning', 'info']).toContain(issue.severity);
      expect(['discovery', 'actionability', 'friction', 'safety']).toContain(issue.pillar);
    }

    // Ranked most costly first.
    const points = scorecard.issues.map((issue) => issue.deductionPoints);
    expect([...points].sort((a, b) => b - a)).toEqual(points);
    expect(scorecard.summary.topIssueId).toBe(scorecard.issues[0].id);
  });

  it('attributes issues back to their pillar', () => {
    const scorecard = scoreAudit(mockSiteData, { now: FIXED_CLOCK });
    const allIds = new Set(scorecard.issues.map((issue) => issue.id));
    for (const pillar of scorecard.pillars) {
      for (const id of pillar.issueIds) expect(allIds.has(id)).toBe(true);
      const owned = scorecard.issues.filter((issue) => issue.pillar === pillar.pillar);
      expect(pillar.issueIds).toEqual(owned.map((issue) => issue.id));
    }
  });

  it('summarises the scored surface consistently', () => {
    const scorecard = scoreAudit(mockSiteData, { now: FIXED_CLOCK });
    const { summary } = scorecard;
    expect(summary.toolCount).toBe(mockSiteData.tools.length);
    expect(summary.frictionTrapCount).toBe(mockSiteData.frictionTraps.length);
    expect(summary.coveredCriticalSurfaceCount + summary.domOnlyCriticalSurfaceCount).toBe(
      summary.criticalSurfaceCount,
    );
    const severityTotal = Object.values(summary.issuesBySeverity).reduce((a, b) => a + b, 0);
    expect(severityTotal).toBe(scorecard.issues.length);
  });
});

/* -------------------------------------------------------------------------- */

describe('gradeFor — band mapping', () => {
  it('maps each band at its boundaries', () => {
    expect(gradeFor(100)).toBe('A');
    expect(gradeFor(90)).toBe('A');
    expect(gradeFor(89.99)).toBe('B');
    expect(gradeFor(80)).toBe('B');
    expect(gradeFor(79.99)).toBe('C');
    expect(gradeFor(70)).toBe('C');
    expect(gradeFor(69.99)).toBe('D');
    expect(gradeFor(60)).toBe('D');
    expect(gradeFor(59.99)).toBe('F');
    expect(gradeFor(0)).toBe('F');
  });

  it('clamps values outside 0–100 and rejects NaN', () => {
    expect(gradeFor(-50)).toBe('F');
    expect(gradeFor(1000)).toBe('A');
    expect(gradeFor(Number.NaN)).toBe('F');
    expect(gradeFor(Number.POSITIVE_INFINITY)).toBe('A');
  });
});

/* -------------------------------------------------------------------------- */

describe('scoreAudit — edge cases', () => {
  it('handles zero tools with ten friction traps', () => {
    const data = makeAuditData({
      tools: [],
      forms: [makeForm({ id: 'form-1', category: 'checkout', selector: 'form#checkout' })],
      frictionTraps: Array.from({ length: 10 }, (_, index) =>
        makeTrap({
          id: `trap-${index + 1}`,
          severity: index < 4 ? 'critical' : index < 7 ? 'high' : 'medium',
          formId: 'form-1',
        }),
      ),
    });

    const scorecard = scoreAudit(data, { now: FIXED_CLOCK });
    expect(findNonFiniteNumbers(scorecard)).toEqual([]);
    expect(scorecard.overallScore).toBeGreaterThanOrEqual(0);
    expect(scorecard.overallScore).toBeLessThanOrEqual(100);
    expect(scorecard.grade).toBe('F');

    // Friction is saturated; discovery, actionability and safety are all empty.
    const friction = scorecard.pillars.find((pillar) => pillar.pillar === 'friction')!;
    expect(friction.rawScore).toBe(0);
    const actionability = scorecard.pillars.find((pillar) => pillar.pillar === 'actionability')!;
    expect(actionability.rawScore).toBe(0);
    const safety = scorecard.pillars.find((pillar) => pillar.pillar === 'safety')!;
    expect(safety.rawScore).toBe(0);

    const deducted = scorecard.issues.reduce((total, issue) => total + issue.deductionPoints, 0);
    expect(deducted).toBeCloseTo(100 - scorecard.overallScoreExact, 3);
    expect(scorecard.issues.some((issue) => issue.severity === 'critical')).toBe(true);
  });

  it('handles ten well-formed tools with zero friction traps', () => {
    const tools = [
      makeTool({ name: 'search_products', annotations: { readOnlyHint: true } }),
      makeTool({ name: 'list_orders', annotations: { readOnlyHint: true } }),
      makeTool({ name: 'get_order_status', annotations: { readOnlyHint: true } }),
      makeTool({ name: 'track_shipment', annotations: { readOnlyHint: true } }),
      makeTool({ name: 'find_store', annotations: { readOnlyHint: true } }),
      makeTool({ name: 'add_to_cart', annotations: { readOnlyHint: false } }),
      makeTool({ name: 'place_order', annotations: { readOnlyHint: false, destructiveHint: true } }),
      makeTool({ name: 'sign_in', annotations: { readOnlyHint: false } }),
      makeTool({ name: 'create_account', annotations: { readOnlyHint: false } }),
      makeTool({ name: 'subscribe_newsletter', annotations: { readOnlyHint: false } }),
    ];

    const data = makeAuditData({
      tools,
      forms: [
        makeForm({ id: 'form-1', category: 'search', selector: 'form#search' }),
        makeForm({ id: 'form-2', category: 'checkout', selector: 'form#checkout' }),
        makeForm({ id: 'form-3', category: 'authentication', selector: 'form#login' }),
      ],
      frictionTraps: [],
      declarative: {
        descriptors: makeDescriptors({ mcp: true, agent: true, llms: true }),
        tags: [],
        tools: [],
        manifestLinks: [{ rel: 'mcp-manifest', href: '/.well-known/mcp', type: null, resolved: 'https://example.test/.well-known/mcp' }],
      },
      page: {
        title: 'Shop',
        lang: 'en',
        description: 'A shop.',
        landmarkCount: 4,
        hasSingleMainLandmark: true,
        headingLevels: [1, 2],
        domNodeCount: 300,
        shadowRootCount: 0,
        iframeCount: 0,
        requiresJavaScript: false,
      },
    });

    const scorecard = scoreAudit(data, { now: FIXED_CLOCK });
    expect(findNonFiniteNumbers(scorecard)).toEqual([]);
    expect(scorecard.overallScore).toBeGreaterThanOrEqual(90);
    expect(scorecard.grade).toBe('A');

    const friction = scorecard.pillars.find((pillar) => pillar.pillar === 'friction')!;
    expect(friction.rawScore).toBe(100);
    const safety = scorecard.pillars.find((pillar) => pillar.pillar === 'safety')!;
    expect(safety.rawScore).toBeGreaterThan(90);

    const deducted = scorecard.issues.reduce((total, issue) => total + issue.deductionPoints, 0);
    expect(deducted).toBeCloseTo(100 - scorecard.overallScoreExact, 3);
  });

  it('handles a completely empty scan without dividing by zero', () => {
    const scorecard = scoreAudit(
      makeAuditData({
        page: {
          title: null,
          lang: null,
          description: null,
          landmarkCount: 0,
          hasSingleMainLandmark: false,
          headingLevels: [],
          domNodeCount: 0,
          shadowRootCount: 0,
          iframeCount: 0,
          requiresJavaScript: false,
        },
      }),
      { now: FIXED_CLOCK },
    );

    expect(findNonFiniteNumbers(scorecard)).toEqual([]);
    // Nothing discoverable, nothing actionable, nothing to conform to — the
    // only points available are the friction pillar's, which has no traps.
    expect(scorecard.overallScore).toBe(25);
    expect(scorecard.grade).toBe('F');
    expect(scorecard.summary.criticalSurfaceCount).toBe(0);
    const deducted = scorecard.issues.reduce((total, issue) => total + issue.deductionPoints, 0);
    expect(deducted).toBeCloseTo(75, 3);
  });

  it('caps friction penalty rather than producing a negative pillar', () => {
    const data = makeAuditData({
      frictionTraps: Array.from({ length: 60 }, (_, index) =>
        makeTrap({ id: `trap-${index + 1}`, severity: 'critical' }),
      ),
    });
    const scorecard = scoreAudit(data, { now: FIXED_CLOCK });
    const friction = scorecard.pillars.find((pillar) => pillar.pillar === 'friction')!;
    expect(friction.rawScore).toBe(0);
    expect(friction.weightedPoints).toBe(0);
    expect(scorecard.overallScore).toBeGreaterThanOrEqual(0);
    const deducted = scorecard.issues.reduce((total, issue) => total + issue.deductionPoints, 0);
    expect(deducted).toBeCloseTo(100 - scorecard.overallScoreExact, 3);
  });

  it('does not mistake a query tool for a mutation because of its prose', () => {
    // "return the matching items" and "order status" are prose, not intent —
    // matching them made read-only query tools look mislabelled.
    const queries = [
      makeTool({ name: 'get_order_status', description: 'Return the fulfilment status of an order.' }),
      makeTool({ name: 'filter_issues', description: 'Filter findings and return the matches.' }),
      makeTool({ name: 'track_order', description: 'Look up the delivery status of an order.' }),
    ];
    for (const tool of queries) expect(classifyToolByLanguage(tool), tool.name).toBe('query');

    // A genuine returns flow is still a mutation.
    expect(
      classifyToolByLanguage(
        makeTool({ name: 'start_return', description: 'Open a return request for a delivered line.' }),
      ),
    ).toBe('mutation');

    const scorecard = scoreAudit(
      makeAuditData({ tools: queries, forms: [makeForm({ id: 'form-1', category: 'search' })] }),
      { now: FIXED_CLOCK },
    );
    expect(scorecard.issues.some((issue) => issue.id === 'safety.mislabelled-read-only-tools')).toBe(false);
  });

  it('flags a tool mislabelled as read-only', () => {
    const data = makeAuditData({
      tools: [makeTool({ name: 'place_order', annotations: { readOnlyHint: true } })],
      forms: [makeForm({ id: 'form-1', category: 'checkout' })],
    });
    expect(classifyToolByLanguage(data.tools[0])).toBe('mutation');

    const scorecard = scoreAudit(data, { now: FIXED_CLOCK });
    const issue = scorecard.issues.find((entry) => entry.id === 'safety.mislabelled-read-only-tools');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('critical');
    expect(issue!.deductionPoints).toBeGreaterThan(0);
    expect(issue!.evidence.mislabelled).toEqual(['place_order']);
  });

  it('surfaces scanner diagnostics without moving the score', () => {
    const clean = makeAuditData();
    const noisy = makeAuditData({
      diagnostics: [
        { level: 'warning', stage: 'descriptors', code: 'descriptor-probe-failed', message: 'Timed out.', at: '2026-01-01T00:00:00.000Z' },
        { level: 'error', stage: 'dom', code: 'dom-inspection-failed', message: 'Evaluate threw.', at: '2026-01-01T00:00:01.000Z' },
      ],
    });

    const cleanCard = scoreAudit(clean, { now: FIXED_CLOCK });
    const noisyCard = scoreAudit(noisy, { now: FIXED_CLOCK });

    expect(noisyCard.overallScoreExact).toBe(cleanCard.overallScoreExact);
    const diagnosticIssues = noisyCard.issues.filter((issue) => issue.id.startsWith('scan.'));
    expect(diagnosticIssues).toHaveLength(2);
    expect(diagnosticIssues.every((issue) => issue.deductionPoints === 0)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

describe('benchmark — token tax calculator', () => {
  it('models the mock storefront with WebMCP strictly cheaper than DOM', () => {
    const comparison = estimateBenchmark(mockSiteData);
    expect(findNonFiniteNumbers(comparison)).toEqual([]);

    expect(comparison.domTraversal.totalTokens).toBeGreaterThan(comparison.webMcpDirect.totalTokens);
    expect(comparison.domTraversal.latencyMs).toBeGreaterThan(comparison.webMcpDirect.latencyMs);
    expect(comparison.domTraversal.steps).toBeGreaterThan(comparison.webMcpDirect.steps);
    expect(comparison.frictionTax.tokensWasted).toBeGreaterThan(0);
    expect(comparison.frictionTax.costWastedUsd).toBeGreaterThan(0);
    expect(comparison.frictionTax.secondsWasted).toBeGreaterThan(0);
    expect(comparison.frictionTax.headline).toMatch(/^\$[\d.]+ and [\d.]+s wasted per user transaction without WebMCP/);
    expect(comparison.pricing).toEqual(DEFAULT_PRICING);
    expect(comparison.assumptions.length).toBeGreaterThan(2);
  });

  it('keeps probabilities inside [0, 1] and retries finite', () => {
    const data = makeAuditData({
      frictionTraps: Array.from({ length: 40 }, (_, index) =>
        makeTrap({ id: `trap-${index + 1}`, severity: 'critical' }),
      ),
    });
    const comparison = estimateBenchmark(data);
    expect(comparison.domTraversal.failureProbability).toBeGreaterThan(0);
    expect(comparison.domTraversal.failureProbability).toBeLessThanOrEqual(0.95);
    expect(comparison.webMcpDirect.failureProbability).toBeLessThanOrEqual(0.95);
    expect(Number.isFinite(comparison.domTraversal.expectedRetries)).toBe(true);
    expect(comparison.domTraversal.expectedRetries).toBeLessThanOrEqual(20);
    expect(comparison.frictionTax.failureProbabilityDelta).toBeGreaterThanOrEqual(0);
    expect(comparison.frictionTax.failureProbabilityDelta).toBeLessThanOrEqual(1);
  });

  it('survives a scan that found nothing at all', () => {
    const empty = makeAuditData({
      page: {
        title: null,
        lang: null,
        description: null,
        landmarkCount: 0,
        hasSingleMainLandmark: false,
        headingLevels: [],
        domNodeCount: 0,
        shadowRootCount: 0,
        iframeCount: 0,
        requiresJavaScript: false,
      },
    });
    const comparison = estimateBenchmark(empty);
    expect(findNonFiniteNumbers(comparison)).toEqual([]);
    expect(comparison.domTraversal.totalTokens).toBeGreaterThan(0);
    expect(comparison.webMcpDirect.totalTokens).toBeGreaterThan(0);
    expect(comparison.frictionTax.tokensWasted).toBeGreaterThanOrEqual(0);
    expect(comparison.frictionTax.tokenMultiple).not.toBeNull();
    expect(schemaClarity(empty)).toBe(0);
    expect(
      comparison.assumptions.some((assumption) => assumption.includes('reference single-tool schema')),
    ).toBe(true);
  });

  it('grows the tax monotonically with friction', () => {
    const base = makeAuditData({ forms: [makeForm({ id: 'form-1', category: 'checkout' })] });
    const withTraps = makeAuditData({
      forms: [makeForm({ id: 'form-1', category: 'checkout' })],
      frictionTraps: Array.from({ length: 6 }, (_, index) =>
        makeTrap({ id: `trap-${index + 1}`, severity: 'high', formId: 'form-1' }),
      ),
    });

    const clean = estimateBenchmark(base);
    const dirty = estimateBenchmark(withTraps);
    expect(dirty.domTraversal.steps).toBeGreaterThan(clean.domTraversal.steps);
    expect(dirty.frictionTax.tokensWasted).toBeGreaterThan(clean.frictionTax.tokensWasted);
    expect(dirty.frictionTax.latencyWastedMs).toBeGreaterThan(clean.frictionTax.latencyWastedMs);
    expect(dirty.domTraversal.failureProbability).toBeGreaterThan(clean.domTraversal.failureProbability);
  });

  it('honours pricing and latency overrides', () => {
    const cheap = estimateBenchmark(mockSiteData, {
      pricing: { model: 'test-model', inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
    });
    const dear = estimateBenchmark(mockSiteData, {
      pricing: { model: 'test-model', inputPerMillionUsd: 10, outputPerMillionUsd: 20 },
    });
    expect(dear.domTraversal.costUsd).toBeGreaterThan(cheap.domTraversal.costUsd);
    expect(cheap.pricing.model).toBe('test-model');

    const slow = estimateBenchmark(mockSiteData, { domActionLatencyMs: 5_000 });
    const fast = estimateBenchmark(mockSiteData, { domActionLatencyMs: 100 });
    expect(slow.domTraversal.latencyMs).toBeGreaterThan(fast.domTraversal.latencyMs);
  });

  it('ignores invalid tuning values rather than producing NaN', () => {
    const comparison = estimateBenchmark(mockSiteData, {
      outputTokensPerSecond: 0,
      modelOverheadMs: Number.NaN,
      domActionLatencyMs: -100,
    });
    expect(findNonFiniteNumbers(comparison)).toEqual([]);
    expect(comparison.domTraversal.latencyMs).toBeGreaterThan(0);
  });

  it('computes costs and taxes without negative values', () => {
    expect(costOf(0, 0, DEFAULT_PRICING)).toBe(0);
    expect(costOf(-100, -100, DEFAULT_PRICING)).toBe(0);
    expect(costOf(1_000_000, 1_000_000, DEFAULT_PRICING)).toBe(30);

    // A DOM run cheaper than the tool run (impossible in practice) floors at 0.
    const inverted = computeFrictionTax(
      { ...estimateBenchmark(makeAuditData()).webMcpDirect, mode: 'dom-traversal' },
      estimateBenchmark(makeAuditData()).domTraversal,
    );
    expect(inverted.tokensWasted).toBe(0);
    expect(inverted.costWastedUsd).toBe(0);
    expect(inverted.secondsWasted).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */

describe('synthetic agent — simulated driver', () => {
  it('selects a matching tool and synthesizes schema-valid arguments', async () => {
    const evaluation = await runSyntheticEvaluation(mockSiteData, {
      goal: 'Execute product search',
      useLiveDriver: false,
    });

    expect(evaluation.mode).toBe('webmcp-direct');
    expect(evaluation.driver).toBe('simulated');
    expect(evaluation.live).toBe(false);
    expect(evaluation.attempts).toHaveLength(1);

    const attempt = evaluation.attempts[0];
    expect(attempt.toolName).toBe('search_products');
    expect(attempt.execution).toBe('dry-run');
    expect(attempt.readOnly).toBe(true);
    expect(attempt.schemaSatisfied).toBe(true);
    expect(attempt.arguments).toHaveProperty('query');
    expect(evaluation.success).toBe(true);
  });

  it('is deterministic', async () => {
    const clock = () => 0;
    const a = await runSyntheticEvaluation(mockSiteData, { goal: 'Execute product search', useLiveDriver: false, now: clock });
    const b = await runSyntheticEvaluation(mockSiteData, { goal: 'Execute product search', useLiveDriver: false, now: clock });
    expect(a).toEqual(b);
  });

  it('falls back to a DOM plan when no tools are registered', async () => {
    const data = makeAuditData({
      forms: [
        makeForm({
          id: 'form-1',
          category: 'checkout',
          selector: 'form#checkout',
          fields: [
            { tagName: 'input', type: 'text', name: 'coupon', id: 'coupon', accessibleName: null, labelSource: null, required: false, autocomplete: null, selector: '#coupon' },
          ],
          trapIds: ['trap-1'],
        }),
      ],
      frictionTraps: [makeTrap({ id: 'trap-1', selector: '#coupon', type: 'unlabelled-input', severity: 'critical', formId: 'form-1' })],
    });

    const evaluation = await runSyntheticEvaluation(data, { goal: 'Inspect checkout flow', useLiveDriver: false });
    expect(evaluation.mode).toBe('dom-fallback');
    expect(evaluation.resolvedGoal).toBe('checkout');
    expect(evaluation.success).toBe(false);
    expect(evaluation.attempts).toEqual([]);
    expect(evaluation.plan.length).toBeGreaterThan(3);
    expect(evaluation.plan.map((step) => step.order)).toEqual(
      evaluation.plan.map((_, index) => index + 1),
    );
    for (const step of evaluation.plan) {
      expect(step.riskScore).toBeGreaterThanOrEqual(0);
      expect(step.riskScore).toBeLessThanOrEqual(1);
    }
    const blocked = evaluation.plan.filter((step) => step.blockedByTrapIds.includes('trap-1'));
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked[0].riskScore).toBeGreaterThan(0.3);
  });

  it('falls back to a DOM plan when no registered tool serves the goal', async () => {
    const data = makeAuditData({
      tools: [makeTool({ name: 'unrelated_widget', description: 'Renders a decorative widget.' })],
      forms: [makeForm({ id: 'form-1', category: 'checkout' })],
    });
    const evaluation = await runSyntheticEvaluation(data, { goal: 'Complete the purchase', useLiveDriver: false });
    expect(evaluation.mode).toBe('dom-fallback');
    expect(evaluation.reasoning).toContain('match the goal');
  });

  it('reports a missing-credentials warning when auto-resolving without a key', async () => {
    const previousKey = process.env.ANTHROPIC_API_KEY;
    const previousToken = process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      const evaluation = await runSyntheticEvaluation(mockSiteData, { goal: 'Execute product search' });
      expect(evaluation.driver).toBe('simulated');
      expect(evaluation.warnings.join(' ')).toContain('ANTHROPIC_API_KEY');
    } finally {
      if (previousKey !== undefined) process.env.ANTHROPIC_API_KEY = previousKey;
      if (previousToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = previousToken;
    }
  });

  it('recovers from a driver that throws', async () => {
    const evaluation = await runSyntheticEvaluation(mockSiteData, {
      goal: 'Execute product search',
      driver: {
        kind: 'custom',
        async selectTool() {
          throw new Error('driver exploded');
        },
      },
    });
    expect(evaluation.warnings.join(' ')).toContain('driver exploded');
    expect(evaluation.attempts[0].toolName).toBe('search_products');
  });

  it('synthesizes typed values from a schema', () => {
    const tool = makeTool({
      name: 'book_slot',
      inputSchema: {
        raw: {
          type: 'object',
          properties: {
            email: { type: 'string', format: 'email' },
            quantity: { type: 'integer', minimum: 2 },
            express: { type: 'boolean' },
            tier: { type: 'string', enum: ['standard', 'premium'] },
            note: { type: 'string' },
          },
          required: ['email', 'quantity', 'express', 'tier'],
        },
        type: 'object',
        propertyNames: ['email', 'quantity', 'express', 'tier', 'note'],
        required: ['email', 'quantity', 'express', 'tier'],
        isStructured: true,
      },
    });

    const args = synthesizeArguments(tool, 'Book a slot');
    expect(args).toEqual({
      email: 'agentgrade-synthetic@example.com',
      quantity: 2,
      express: false,
      tier: 'standard',
    });
    expect(satisfiesSchema(tool, args)).toBe(true);
    expect(satisfiesSchema(tool, {})).toBe(false);
  });

  it('builds a plan for a target with no catalogued surface', () => {
    const plan = buildDomPlan(makeAuditData(), 'checkout');
    expect(plan.length).toBeGreaterThan(0);
    expect(plan[0].action).toBe('read');
    expect(plan.some((step) => step.intent.includes('explore navigation'))).toBe(true);
  });

  it('scores tool selection stably regardless of tool order', () => {
    const driver = new SimulatedDriver();
    const tools = [
      makeTool({ name: 'add_to_cart', description: 'Add an item to the cart.' }),
      makeTool({ name: 'search_products', description: 'Search the catalog.' }),
    ];
    const forward = driver.selectToolSync({ goal: 'Execute product search', resolvedGoal: 'search', tools, pageSummary: '' });
    const reversed = driver.selectToolSync({
      goal: 'Execute product search',
      resolvedGoal: 'search',
      tools: [...tools].reverse(),
      pageSummary: '',
    });
    expect(forward.toolName).toBe('search_products');
    expect(reversed.toolName).toBe(forward.toolName);
  });
});

/* -------------------------------------------------------------------------- */

describe('synthetic agent — live Playwright invocation', () => {
  let page: Page;

  beforeAll(async () => {
    page = await browser.newPage();
    await page.goto(server.url('/'), { waitUntil: 'networkidle' });
  }, 60_000);

  afterAll(async () => {
    await page?.close().catch(() => undefined);
  });

  it('really invokes a read-only tool in the page', async () => {
    const evaluation = await runSyntheticEvaluation(mockSiteData, {
      goal: 'Execute product search',
      page,
      useLiveDriver: false,
    });

    expect(evaluation.live).toBe(true);
    const attempt = evaluation.attempts[0];
    expect(attempt.toolName).toBe('search_products');
    expect(attempt.execution).toBe('executed');
    expect(attempt.error).toBeNull();
    expect(attempt.result).toMatchObject({ content: [{ type: 'text' }] });
    expect(evaluation.success).toBe(true);
  });

  it('refuses to invoke a mutating tool without explicit opt-in', async () => {
    const evaluation = await runSyntheticEvaluation(mockSiteData, {
      goal: 'Add an item to the cart',
      page,
      useLiveDriver: false,
    });

    const attempt = evaluation.attempts[0];
    expect(attempt.toolName).toBe('add_to_cart');
    expect(attempt.readOnly).toBe(false);
    expect(attempt.execution).toBe('skipped-mutating');
    expect(evaluation.warnings.join(' ')).toContain('allowMutations');
  });

  it('invokes a mutating tool once explicitly allowed', async () => {
    const evaluation = await runSyntheticEvaluation(mockSiteData, {
      goal: 'Add an item to the cart',
      page,
      allowMutations: true,
      useLiveDriver: false,
    });

    const attempt = evaluation.attempts[0];
    expect(attempt.toolName).toBe('add_to_cart');
    expect(attempt.execution).toBe('executed');
    expect(attempt.result).toMatchObject({ content: [{ type: 'text' }] });
  });

  it('reports an error for a tool that is not present at runtime', async () => {
    const data = makeAuditData({
      tools: [makeTool({ name: 'search_ghost', description: 'Search something that does not exist.', executable: true })],
    });
    const evaluation = await runSyntheticEvaluation(data, {
      goal: 'Execute product search',
      page,
      useLiveDriver: false,
    });
    const attempt = evaluation.attempts[0];
    expect(attempt.execution).toBe('error');
    expect(attempt.error).toContain('not present at runtime');
    expect(evaluation.success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('scorecard integration', () => {
  it('attaches a synthetic evaluation to the scorecard', async () => {
    const evaluation = await runSyntheticEvaluation(mockSiteData, {
      goal: 'Execute product search',
      useLiveDriver: false,
    });
    const scorecard = scoreAudit(mockSiteData, { now: FIXED_CLOCK, syntheticEvaluation: evaluation });
    expect(scorecard.syntheticEvaluation).toEqual(evaluation);
    expect(scoreAudit(mockSiteData, { now: FIXED_CLOCK }).syntheticEvaluation).toBeNull();
  });

  it('exposes safeRatio guards used throughout the layer', () => {
    expect(safeRatio(1, 0)).toBe(0);
    expect(safeRatio(0, 0, 1)).toBe(1);
    expect(safeRatio(5, 2)).toBe(1);
    expect(safeRatio(Number.NaN, 2)).toBe(0);
    const ids: PillarId[] = ['discovery', 'actionability', 'friction', 'safety'];
    expect(ids.every((id) => PILLAR_WEIGHTS[id] > 0)).toBe(true);
  });
});
