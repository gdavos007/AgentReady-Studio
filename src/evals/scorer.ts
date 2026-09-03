/**
 * AgentGrade — deterministic scoring engine.
 *
 * Turns an {@link AgentAuditRawData} payload into an {@link AgentScorecard}:
 * four weighted pillars, a 0–100 composite, a letter grade, and a ranked list of
 * issues whose deductions reconcile exactly against the score.
 *
 * Determinism is a hard requirement. There is no randomness, no wall-clock in
 * any scored quantity (only in the `generatedAt` metadata, which is injectable),
 * and every ratio is guarded so that an empty or degenerate scan yields a
 * bounded number rather than `NaN`.
 */

import type { AgentAuditRawData } from '../scanner/types.js';
import {
  assessSchema,
  classifyToolByLanguage,
  clamp,
  deriveSurfaceCoverage,
  hasClearDescription,
  round,
  safeRatio,
  weightedTrapPenalty,
  type SurfaceCoverage,
} from './analysis.js';
import { estimateBenchmark } from './benchmark.js';
import { synthesizeIssues } from './issues.js';
import {
  PILLAR_LABELS,
  PILLAR_WEIGHTS,
  SCORECARD_SCHEMA_VERSION,
  type AgentScorecard,
  type AuditIssue,
  type Grade,
  type IssueSeverity,
  type PillarId,
  type PillarScore,
  type ScoreComponent,
  type ScorecardSummary,
  type ScoringOptions,
} from './types.js';

/* -------------------------------------------------------------------------- */
/* Grade mapping                                                               */
/* -------------------------------------------------------------------------- */

/** Lower bound of each grade band, highest first. */
export const GRADE_BANDS: ReadonlyArray<{ grade: Grade; min: number }> = [
  { grade: 'A', min: 90 },
  { grade: 'B', min: 80 },
  { grade: 'C', min: 70 },
  { grade: 'D', min: 60 },
  { grade: 'F', min: 0 },
];

/**
 * Maps a 0–100 score to its letter grade.
 * A: 90–100, B: 80–89, C: 70–79, D: 60–69, F: below 60.
 */
export function gradeFor(score: number): Grade {
  const bounded = clamp(score, 0, 100);
  for (const band of GRADE_BANDS) {
    if (bounded >= band.min) return band.grade;
  }
  return 'F';
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Scores a completed scan.
 *
 * @param data  Phase 1 raw audit data.
 * @param options Optional clock injection, benchmark tuning, and a synthetic
 *   evaluation to attach.
 */
export function scoreAudit(data: AgentAuditRawData, options: ScoringOptions = {}): AgentScorecard {
  const coverage = deriveSurfaceCoverage(data);

  const pillars: PillarScore[] = [
    finalisePillar('discovery', scoreDiscovery(data)),
    finalisePillar('actionability', scoreActionability(data, coverage)),
    finalisePillar('friction', scoreFriction(data)),
    finalisePillar('safety', scoreSafety(data)),
  ];

  const overallScoreExact = round(
    pillars.reduce((total, pillar) => total + pillar.weightedPoints, 0),
    4,
  );
  const overallScore = Math.round(overallScoreExact);

  const benchmark = estimateBenchmark(data, options.benchmark);
  const issues = synthesizeIssues({ data, coverage, pillars, overallScoreExact });

  // Back-link issues onto the pillar that produced them.
  for (const pillar of pillars) {
    pillar.issueIds = issues.filter((issue) => issue.pillar === pillar.pillar).map((issue) => issue.id);
  }

  const now = options.now ?? (() => new Date());

  return {
    schemaVersion: SCORECARD_SCHEMA_VERSION,
    scorecardId: `scorecard_${data.scanId}`,
    generatedAt: now().toISOString(),
    target: {
      requestedUrl: data.target.requestedUrl,
      finalUrl: data.navigation.finalUrl,
      origin: data.target.origin,
      scanId: data.scanId,
    },
    overallScore,
    overallScoreExact,
    grade: gradeFor(overallScoreExact),
    pillars,
    issues,
    benchmark,
    syntheticEvaluation: options.syntheticEvaluation ?? null,
    summary: summarise(data, coverage, issues),
  };
}

/* -------------------------------------------------------------------------- */
/* Pillar 1 — Discovery (20%)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Can an agent find out what this site can do *before* touching the DOM?
 *
 * Budget: llms.txt 15, /.well-known/mcp 25, /.well-known/agent.json 15,
 * semantic metadata 20, tool description clarity 25.
 */
function scoreDiscovery(data: AgentAuditRawData): ScoreComponent[] {
  const descriptorOf = (kind: 'well-known-mcp' | 'well-known-agent' | 'llms-txt') =>
    data.declarative.descriptors.find((probe) => probe.kind === kind) ?? null;

  const llms = descriptorOf('llms-txt');
  const mcp = descriptorOf('well-known-mcp');
  const agent = descriptorOf('well-known-agent');

  const manifestTools = data.tools.filter(
    (tool) => tool.source === 'well-known-mcp' || tool.source === 'well-known-agent',
  );
  const mcpDeclaresTools = manifestTools.some((tool) => tool.source === 'well-known-mcp');

  const components: ScoreComponent[] = [];

  components.push({
    id: 'llms-txt',
    label: '/llms.txt published',
    earned: llms?.found ? 15 : 0,
    possible: 15,
    detail: llms?.found
      ? `Served ${llms.byteLength} bytes of capability prose at ${llms.url}.`
      : 'No /llms.txt was served, so an agent has no prose description of what this site offers.',
    evidence: { found: llms?.found ?? false, status: llms?.status ?? null, url: llms?.url ?? null },
  });

  components.push({
    id: 'well-known-mcp',
    label: '/.well-known/mcp manifest',
    earned: mcp?.found ? (mcpDeclaresTools ? 25 : 15) : 0,
    possible: 25,
    detail: !mcp?.found
      ? 'No /.well-known/mcp manifest resolved, so tools cannot be discovered without executing the page.'
      : mcpDeclaresTools
        ? `Manifest resolved and declares ${manifestTools.filter((tool) => tool.source === 'well-known-mcp').length} tool(s).`
        : 'Manifest resolved but declares no tools, so it advertises nothing an agent can call.',
    evidence: {
      found: mcp?.found ?? false,
      status: mcp?.status ?? null,
      declaredTools: manifestTools.filter((tool) => tool.source === 'well-known-mcp').length,
    },
  });

  components.push({
    id: 'well-known-agent',
    label: '/.well-known/agent.json card',
    earned: agent?.found ? 15 : 0,
    possible: 15,
    detail: agent?.found
      ? 'Agent card resolved and parsed as JSON.'
      : 'No agent card resolved, so an agent cannot learn this service’s identity or skills declaratively.',
    evidence: { found: agent?.found ?? false, status: agent?.status ?? null },
  });

  // Semantic metadata: six equally-weighted signals inside a 20-point budget.
  const semanticSignals: Array<{ id: string; ok: boolean }> = [
    { id: 'title', ok: !!data.page.title },
    { id: 'description', ok: !!data.page.description },
    { id: 'lang', ok: !!data.page.lang },
    { id: 'single-main-landmark', ok: data.page.hasSingleMainLandmark },
    { id: 'h1', ok: data.page.headingLevels.includes(1) },
    { id: 'manifest-link', ok: data.declarative.manifestLinks.length > 0 },
  ];
  const semanticHits = semanticSignals.filter((signal) => signal.ok).length;
  components.push({
    id: 'semantic-metadata',
    label: 'Semantic page metadata',
    earned: round(20 * safeRatio(semanticHits, semanticSignals.length), 4),
    possible: 20,
    detail: `${semanticHits} of ${semanticSignals.length} semantic signals present (title, description, lang, main landmark, h1, manifest link).`,
    evidence: {
      present: semanticSignals.filter((signal) => signal.ok).map((signal) => signal.id),
      missing: semanticSignals.filter((signal) => !signal.ok).map((signal) => signal.id),
    },
  });

  const clearTools = data.tools.filter(hasClearDescription);
  components.push({
    id: 'tool-description-clarity',
    label: 'Registered tool descriptions',
    // With no tools there is nothing to describe clearly, and nothing to earn.
    earned: data.tools.length === 0 ? 0 : round(25 * safeRatio(clearTools.length, data.tools.length), 4),
    possible: 25,
    detail:
      data.tools.length === 0
        ? 'No tools are registered, so there are no descriptions for an agent to reason over.'
        : `${clearTools.length} of ${data.tools.length} tool(s) carry a description that explains the action rather than restating the name.`,
    evidence: {
      toolCount: data.tools.length,
      clearCount: clearTools.length,
      unclear: data.tools.filter((tool) => !hasClearDescription(tool)).map((tool) => tool.name).slice(0, 20),
    },
  });

  return components;
}

/* -------------------------------------------------------------------------- */
/* Pillar 2 — Actionability & Surface Coverage (35%)                           */
/* -------------------------------------------------------------------------- */

/**
 * Can an agent *do* the things this page is for, without driving raw DOM?
 *
 * When critical surfaces exist the pillar is coverage-driven (55 critical
 * coverage, 15 overall coverage, 15 executable tools, 15 DOM-only exposure).
 * When the page exposes no critical surface at all there is nothing to cover,
 * so the pillar falls back to scoring the tool surface on its own.
 */
function scoreActionability(data: AgentAuditRawData, coverage: SurfaceCoverage[]): ScoreComponent[] {
  const critical = coverage.filter((entry) => entry.critical);
  const executableTools = data.tools.filter((tool) => tool.executable);

  if (critical.length === 0) {
    const earned = executableTools.length > 0 ? 100 : data.tools.length > 0 ? 60 : 0;
    return [
      {
        id: 'tool-surface-only',
        label: 'Agent-actionable surface',
        earned,
        possible: 100,
        detail:
          executableTools.length > 0
            ? `No critical DOM surface was detected; ${executableTools.length} executable tool(s) carry the agent-facing surface instead.`
            : data.tools.length > 0
              ? `No critical DOM surface was detected and ${data.tools.length} tool(s) are declared but none are executable at runtime.`
              : 'This page exposes neither a critical interactive surface nor any registered tool, so there is nothing an agent can act on.',
        evidence: {
          criticalSurfaceCount: 0,
          toolCount: data.tools.length,
          executableToolCount: executableTools.length,
        },
      },
    ];
  }

  const coveredCritical = critical.filter((entry) => !entry.domOnly);
  const domOnlyCritical = critical.filter((entry) => entry.domOnly);
  const coveredAll = coverage.filter((entry) => !entry.domOnly);

  const criticalRatio = safeRatio(coveredCritical.length, critical.length);
  const overallRatio = safeRatio(coveredAll.length, coverage.length);
  const executableRatio = clamp(safeRatio(executableTools.length, critical.length), 0, 1);
  const exposureRatio = 1 - safeRatio(domOnlyCritical.length, critical.length);

  return [
    {
      id: 'critical-surface-coverage',
      label: 'Critical surfaces backed by tools',
      earned: round(55 * criticalRatio, 4),
      possible: 55,
      detail: `${coveredCritical.length} of ${critical.length} critical surface(s) (search, checkout, authentication, signup) are backed by a registered WebMCP tool.`,
      evidence: {
        criticalCount: critical.length,
        coveredCount: coveredCritical.length,
        covered: coveredCritical.map((entry) => `${entry.form.category}:${entry.form.selector}`).slice(0, 20),
        uncovered: domOnlyCritical.map((entry) => `${entry.form.category}:${entry.form.selector}`).slice(0, 20),
      },
    },
    {
      id: 'overall-surface-coverage',
      label: 'All surfaces backed by tools',
      earned: round(15 * overallRatio, 4),
      possible: 15,
      detail: `${coveredAll.length} of ${coverage.length} interactive surface(s) map to a registered tool.`,
      evidence: { surfaceCount: coverage.length, coveredCount: coveredAll.length },
    },
    {
      id: 'executable-tools',
      label: 'Tools callable at runtime',
      earned: round(15 * executableRatio, 4),
      possible: 15,
      detail:
        executableTools.length === 0
          ? 'No registered tool exposes a callable handler, so every declaration is advisory only.'
          : `${executableTools.length} executable tool(s) available against ${critical.length} critical surface(s).`,
      evidence: {
        executableToolCount: executableTools.length,
        declaredToolCount: data.tools.length,
        executableNames: executableTools.map((tool) => tool.name).slice(0, 20),
      },
    },
    {
      id: 'dom-only-exposure',
      label: 'Critical surfaces left DOM-only',
      earned: round(15 * exposureRatio, 4),
      possible: 15,
      detail:
        domOnlyCritical.length === 0
          ? 'No critical surface is reachable only by driving raw DOM.'
          : `${domOnlyCritical.length} critical surface(s) can only be operated by driving raw DOM.`,
      evidence: {
        domOnlyCount: domOnlyCritical.length,
        selectors: domOnlyCritical.map((entry) => entry.form.selector).slice(0, 20),
      },
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Pillar 3 — Friction & Trap Penalty (25%)                                    */
/* -------------------------------------------------------------------------- */

/**
 * How much of the page actively fights an agent.
 *
 * Starts at 100 and subtracts severity-weighted penalties (critical 12, high 7,
 * medium 3, low 1), amplified 1.5× for a trap sitting inside a critical
 * surface. Linear and clamped at zero: past ~9 critical traps the page is
 * already unusable and further penalty carries no information.
 */
function scoreFriction(data: AgentAuditRawData): ScoreComponent[] {
  const penalty = weightedTrapPenalty(data);
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 } as Record<string, number>;
  for (const trap of data.frictionTraps) bySeverity[trap.severity] = (bySeverity[trap.severity] ?? 0) + 1;

  const byType: Record<string, number> = {};
  for (const trap of data.frictionTraps) byType[trap.type] = (byType[trap.type] ?? 0) + 1;

  return [
    {
      id: 'trap-penalty',
      label: 'Agent friction traps',
      earned: round(clamp(100 - penalty, 0, 100), 4),
      possible: 100,
      detail:
        data.frictionTraps.length === 0
          ? 'No agent friction traps were detected.'
          : `${data.frictionTraps.length} friction trap(s) carry ${penalty} weighted penalty points (capped at 100).`,
      evidence: {
        trapCount: data.frictionTraps.length,
        weightedPenalty: penalty,
        bySeverity,
        byType,
      },
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Pillar 4 — Safety & Schema Conformance (20%)                                */
/* -------------------------------------------------------------------------- */

/**
 * Can an agent call these tools *correctly and safely* on the first attempt?
 *
 * Budget: structured schemas 30, per-parameter descriptions 25, declared
 * `required` 15, `readOnlyHint` correctness 30. A site with no tools earns
 * nothing here — there is no schema conformance to assess.
 */
function scoreSafety(data: AgentAuditRawData): ScoreComponent[] {
  const tools = data.tools;

  if (tools.length === 0) {
    return [
      {
        id: 'no-tools-to-assess',
        label: 'Schema conformance',
        earned: 0,
        possible: 100,
        detail: 'No tools are registered, so there is no input schema or safety annotation to conform to.',
        evidence: { toolCount: 0 },
      },
    ];
  }

  const assessments = tools.map((tool) => ({ tool, quality: assessSchema(tool) }));
  const structured = assessments.filter((entry) => entry.quality.isStructured);

  // Per-parameter documentation, averaged across tools. A structured schema with
  // no parameters has nothing to document and counts as fully documented.
  const documentationScores = assessments.map((entry) => {
    if (!entry.quality.isStructured) return 0;
    if (entry.quality.parameterCount === 0) return 1;
    return entry.quality.parameterDescriptionRatio;
  });
  const documentationRatio = safeRatio(
    documentationScores.reduce((total, value) => total + value, 0),
    documentationScores.length,
  );

  const withParameters = assessments.filter((entry) => entry.quality.parameterCount > 0);
  const requiredRatio =
    withParameters.length === 0
      ? 1
      : safeRatio(withParameters.filter((entry) => entry.quality.declaresRequired).length, withParameters.length);

  const annotationScores = tools.map((tool) => scoreReadOnlyHint(tool));
  const annotationRatio = safeRatio(
    annotationScores.reduce((total, entry) => total + entry.score, 0),
    annotationScores.length,
  );
  const mislabelled = annotationScores.filter((entry) => entry.verdict === 'mislabelled');
  const unannotatedMutations = annotationScores.filter((entry) => entry.verdict === 'unannotated-mutation');

  return [
    {
      id: 'structured-schemas',
      label: 'Typed input schemas',
      earned: round(30 * safeRatio(structured.length, tools.length), 4),
      possible: 30,
      detail: `${structured.length} of ${tools.length} tool(s) declare a structured input schema.`,
      evidence: {
        structuredCount: structured.length,
        toolCount: tools.length,
        unstructured: assessments
          .filter((entry) => !entry.quality.isStructured)
          .map((entry) => entry.tool.name)
          .slice(0, 20),
      },
    },
    {
      id: 'parameter-descriptions',
      label: 'Parameter descriptions',
      earned: round(25 * documentationRatio, 4),
      possible: 25,
      detail: `Parameters are documented at ${round(documentationRatio * 100, 1)}% coverage across ${tools.length} tool(s).`,
      evidence: {
        documentationRatio: round(documentationRatio, 4),
        undocumented: assessments
          .filter((entry) => entry.quality.parameterCount > 0 && entry.quality.parameterDescriptionRatio < 1)
          .map((entry) => entry.tool.name)
          .slice(0, 20),
      },
    },
    {
      id: 'required-parameters',
      label: 'Required parameters declared',
      earned: round(15 * requiredRatio, 4),
      possible: 15,
      detail:
        withParameters.length === 0
          ? 'No tool declares parameters, so there is nothing to mark required.'
          : `${withParameters.filter((entry) => entry.quality.declaresRequired).length} of ${withParameters.length} parameterised tool(s) declare which parameters are required.`,
      evidence: {
        parameterisedToolCount: withParameters.length,
        missingRequired: withParameters
          .filter((entry) => !entry.quality.declaresRequired)
          .map((entry) => entry.tool.name)
          .slice(0, 20),
      },
    },
    {
      id: 'read-only-hints',
      label: 'readOnlyHint annotations',
      earned: round(30 * annotationRatio, 4),
      possible: 30,
      detail:
        mislabelled.length > 0
          ? `${mislabelled.length} tool(s) are annotated read-only despite naming a mutating action.`
          : `Read/write intent is correctly annotated at ${round(annotationRatio * 100, 1)}% across ${tools.length} tool(s).`,
      evidence: {
        annotationRatio: round(annotationRatio, 4),
        mislabelled: mislabelled.map((entry) => entry.toolName),
        unannotatedMutations: unannotatedMutations.map((entry) => entry.toolName),
      },
    },
  ];
}

/** Verdicts the safety pillar reaches about one tool's `readOnlyHint`. */
type AnnotationVerdict = 'correct' | 'mislabelled' | 'unannotated-query' | 'unannotated-mutation' | 'unannotated-unknown';

/**
 * Scores one tool's read/write annotation in `[0, 1]`.
 *
 * An explicit, consistent annotation is full marks. An unannotated query is a
 * small deduction (an agent will guess right). An unannotated mutation earns
 * nothing — the agent cannot tell it is about to spend money. An annotation
 * that contradicts the tool's own name is the worst case and also earns nothing.
 */
function scoreReadOnlyHint(tool: {
  name: string;
  description: string | null;
  annotations: Record<string, unknown>;
}): { toolName: string; score: number; verdict: AnnotationVerdict } {
  const hint = tool.annotations['readOnlyHint'];
  const language = classifyToolByLanguage(tool as Parameters<typeof classifyToolByLanguage>[0]);

  if (hint === true) {
    return language === 'mutation'
      ? { toolName: tool.name, score: 0, verdict: 'mislabelled' }
      : { toolName: tool.name, score: 1, verdict: 'correct' };
  }
  if (hint === false) {
    return { toolName: tool.name, score: 1, verdict: 'correct' };
  }
  if (language === 'query') return { toolName: tool.name, score: 0.4, verdict: 'unannotated-query' };
  if (language === 'mutation') return { toolName: tool.name, score: 0, verdict: 'unannotated-mutation' };
  return { toolName: tool.name, score: 0.2, verdict: 'unannotated-unknown' };
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                    */
/* -------------------------------------------------------------------------- */

/** Folds a pillar's components into its weighted contribution. */
function finalisePillar(pillar: PillarId, components: ScoreComponent[]): PillarScore {
  const possible = components.reduce((total, component) => total + component.possible, 0);
  const earned = components.reduce((total, component) => total + component.earned, 0);
  // Components are authored to total 100; normalise defensively so a future
  // budget change can never push a pillar outside 0..100.
  const rawScore = round(clamp(possible === 0 ? 0 : (earned / possible) * 100, 0, 100), 4);
  const weight = PILLAR_WEIGHTS[pillar];
  const weightedPoints = round(rawScore * weight, 4);
  const maxPoints = round(weight * 100, 4);

  return {
    pillar,
    label: PILLAR_LABELS[pillar],
    weight,
    rawScore,
    weightedPoints,
    maxPoints,
    lostPoints: round(maxPoints - weightedPoints, 4),
    components,
    issueIds: [],
  };
}

function summarise(
  data: AgentAuditRawData,
  coverage: SurfaceCoverage[],
  issues: AuditIssue[],
): ScorecardSummary {
  const critical = coverage.filter((entry) => entry.critical);
  const issuesBySeverity: Record<IssueSeverity, number> = { critical: 0, warning: 0, info: 0 };
  for (const issue of issues) issuesBySeverity[issue.severity] += 1;

  return {
    toolCount: data.tools.length,
    executableToolCount: data.tools.filter((tool) => tool.executable).length,
    criticalSurfaceCount: critical.length,
    coveredCriticalSurfaceCount: critical.filter((entry) => !entry.domOnly).length,
    domOnlyCriticalSurfaceCount: critical.filter((entry) => entry.domOnly).length,
    frictionTrapCount: data.frictionTraps.length,
    issuesBySeverity,
    topIssueId: issues.length > 0 ? issues[0].id : null,
  };
}
