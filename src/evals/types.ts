/**
 * AgentGrade — Phase 2 evaluation data contract.
 *
 * Phase 1 produces {@link AgentAuditRawData}: what is *on* the page. Phase 2
 * turns that into a judgement — what it *costs an agent*, what it *scores*, and
 * what to *fix first*. Every number here is derived deterministically from the
 * raw data (plus an optional live probe), so two runs over the same payload
 * produce byte-identical output.
 */

import type { AgentAuditRawData, JsonValue, RegisteredTool } from '../scanner/types.js';
import type { Grade } from '../shared/grade.js';

/** Schema version of {@link AgentScorecard}. Bump on any breaking change. */
export const SCORECARD_SCHEMA_VERSION = '1.0.0' as const;
export type ScorecardSchemaVersion = typeof SCORECARD_SCHEMA_VERSION;

/* -------------------------------------------------------------------------- */
/* Pillars                                                                     */
/* -------------------------------------------------------------------------- */

/** The four weighted axes of the overall score. */
export type PillarId = 'discovery' | 'actionability' | 'friction' | 'safety';

/**
 * Weights applied to each pillar's 0–100 raw score. Sums to exactly 1.
 * Exported so callers (and tests) can verify the composition.
 */
export const PILLAR_WEIGHTS: Readonly<Record<PillarId, number>> = {
  discovery: 0.2,
  actionability: 0.35,
  friction: 0.25,
  safety: 0.2,
};

/** Human-readable pillar names, used in scorecards and issue copy. */
export const PILLAR_LABELS: Readonly<Record<PillarId, string>> = {
  discovery: 'Discovery',
  actionability: 'Actionability & Surface Coverage',
  friction: 'Friction & Trap Penalty',
  safety: 'Safety & Schema Conformance',
};

/**
 * One scored line item inside a pillar. Components carry their own point
 * budget so an issue can be traced back to the exact points it cost.
 */
export interface ScoreComponent {
  /** Stable identifier, unique within its pillar (e.g. `llms-txt`). */
  id: string;
  /** Short human-readable name. */
  label: string;
  /** Points earned, `0 <= earned <= possible`. */
  earned: number;
  /** Points available for this component within the pillar's 100. */
  possible: number;
  /** One-line explanation of how `earned` was arrived at. */
  detail: string;
  /** Machine-readable supporting facts (ratios, counts, names). */
  evidence: Record<string, JsonValue>;
}

/** A pillar's contribution to the overall score. */
export interface PillarScore {
  pillar: PillarId;
  label: string;
  /** Weight applied to {@link rawScore}; matches {@link PILLAR_WEIGHTS}. */
  weight: number;
  /** 0–100 score within the pillar. */
  rawScore: number;
  /** `rawScore * weight` — this pillar's points out of 100 overall. */
  weightedPoints: number;
  /** `weight * 100` — the most this pillar can contribute. */
  maxPoints: number;
  /** Overall points lost here, i.e. `maxPoints - weightedPoints`. */
  lostPoints: number;
  /** The line items that produced {@link rawScore}. */
  components: ScoreComponent[];
  /** Ids of the {@link AuditIssue}s attributed to this pillar. */
  issueIds: string[];
}

export type { Grade } from '../shared/grade.js';

/* -------------------------------------------------------------------------- */
/* Issues                                                                      */
/* -------------------------------------------------------------------------- */

/** How badly an issue hurts an agent trying to complete a task. */
export type IssueSeverity = 'critical' | 'warning' | 'info';

/** An actionable finding, traceable to the points it cost. */
export interface AuditIssue {
  /** Stable, deterministic identifier (e.g. `actionability.uncovered-checkout`). */
  id: string;
  /** Imperative one-line summary. */
  title: string;
  severity: IssueSeverity;
  pillar: PillarId;
  /** What an agent experiences because of this, in plain language. */
  impactDescription: string;
  /**
   * Overall points (out of 100) lost to this issue. Across all issues these
   * sum to `100 - overallScore`, so a scorecard always reconciles.
   */
  deductionPoints: number;
  /** Concrete fix. */
  remediation: string;
  /** Machine-readable supporting facts. */
  evidence: Record<string, JsonValue>;
  /** CSS selectors of the offending elements, when applicable. */
  relatedSelectors: string[];
  /** Id of the {@link ScoreComponent} this deduction came from, when any. */
  componentId: string | null;
}

/* -------------------------------------------------------------------------- */
/* Benchmark                                                                   */
/* -------------------------------------------------------------------------- */

/** Per-million-token prices used to convert token estimates into dollars. */
export interface PricingModel {
  /** Model id the estimate is quoted for. */
  model: string;
  /** USD per 1M input tokens. */
  inputPerMillionUsd: number;
  /** USD per 1M output tokens. */
  outputPerMillionUsd: number;
}

/**
 * Default pricing: Claude Opus 5 ($5 / $25 per MTok).
 * Override via {@link BenchmarkOptions.pricing} to quote a different model.
 */
export const DEFAULT_PRICING: PricingModel = {
  model: 'claude-opus-5',
  inputPerMillionUsd: 5,
  outputPerMillionUsd: 25,
};

/** One modelled execution mode for a single user transaction. */
export interface BenchmarkMode {
  /** `dom-traversal` (agent reads and clicks the page) or `webmcp-direct`. */
  mode: 'dom-traversal' | 'webmcp-direct';
  /** Model round trips needed to finish the goal. */
  steps: number;
  /** Estimated prompt tokens consumed across all steps. */
  inputTokens: number;
  /** Estimated completion tokens produced across all steps. */
  outputTokens: number;
  /** `inputTokens + outputTokens`. */
  totalTokens: number;
  /** Estimated USD cost at {@link BenchmarkComparison.pricing}. */
  costUsd: number;
  /** Estimated wall-clock latency in milliseconds. */
  latencyMs: number;
  /** Probability in `[0, 1]` that the transaction fails outright. */
  failureProbability: number;
  /** Expected retries implied by {@link failureProbability}. */
  expectedRetries: number;
  /** How the estimate decomposes, for auditability. */
  breakdown: BenchmarkBreakdown;
}

/** Line-by-line derivation of a {@link BenchmarkMode}. */
export interface BenchmarkBreakdown {
  /** Tokens for one serialized view of the page (DOM mode) or the tool schemas. */
  contextTokensPerStep: number;
  /** Tokens the model emits per step. */
  outputTokensPerStep: number;
  /** Steps the goal needs before friction is applied. */
  baseSteps: number;
  /** Extra steps caused by friction traps. */
  frictionSteps: number;
  /** Model latency per step, in milliseconds. */
  modelLatencyMsPerStep: number;
  /** Page/tool execution latency per step, in milliseconds. */
  actionLatencyMsPerStep: number;
  /** Per-step hazard rate used to derive {@link BenchmarkMode.failureProbability}. */
  perStepFailureRate: number;
}

/** The headline "what WebMCP would save you" metric. */
export interface FrictionTax {
  /** Tokens burned by DOM traversal that WebMCP would not need. */
  tokensWasted: number;
  /** Dollars wasted per transaction. */
  costWastedUsd: number;
  /** Milliseconds wasted per transaction. */
  latencyWastedMs: number;
  /** Seconds wasted, rounded to one decimal (for display). */
  secondsWasted: number;
  /** Absolute increase in failure probability, in `[0, 1]`. */
  failureProbabilityDelta: number;
  /** `domTraversal.totalTokens / webMcpDirect.totalTokens`, or `null` if undefined. */
  tokenMultiple: number | null;
  /** Ready-to-print sentence, e.g. `"$0.14 and 18.2s wasted per transaction…"`. */
  headline: string;
}

/** Full DOM-vs-WebMCP comparison for one goal. */
export interface BenchmarkComparison {
  /** The transaction being modelled. */
  goal: BenchmarkGoal;
  pricing: PricingModel;
  domTraversal: BenchmarkMode;
  webMcpDirect: BenchmarkMode;
  frictionTax: FrictionTax;
  /** Stated assumptions, so the numbers can be argued with. */
  assumptions: string[];
}

/** Transaction archetypes the benchmark knows how to model. */
export type BenchmarkGoal = 'search' | 'checkout' | 'authentication' | 'signup' | 'generic';

/* -------------------------------------------------------------------------- */
/* Synthetic evaluation                                                        */
/* -------------------------------------------------------------------------- */

/** Which backend answered the synthetic evaluation. */
export type SyntheticDriverKind = 'anthropic-sdk' | 'vercel-ai-sdk' | 'custom' | 'simulated';

/** One attempted (or dry-run) WebMCP tool invocation. */
export interface ToolInvocationAttempt {
  toolName: string;
  /** Where the tool was declared. */
  source: RegisteredTool['source'];
  /** Synthetic arguments generated from the tool's input schema. */
  arguments: Record<string, JsonValue>;
  /** `dry-run` when no live page was supplied, `executed` when it really ran. */
  execution: 'dry-run' | 'executed' | 'skipped-mutating' | 'error';
  /** JSON-safe result of a live invocation, else `null`. */
  result: JsonValue | null;
  /** Error message when `execution === 'error'`. */
  error: string | null;
  /** Milliseconds the invocation took, or `0` for a dry run. */
  durationMs: number;
  /** True when the tool is classified as read-only. */
  readOnly: boolean;
  /** Whether the synthetic arguments satisfy the declared schema. */
  schemaSatisfied: boolean;
}

/** One step of the fallback DOM plan an agent would have to execute. */
export interface DomPlanStep {
  /** 1-based ordinal. */
  order: number;
  /** `locate` | `focus` | `fill` | `click` | `read` | `wait`. */
  action: 'locate' | 'focus' | 'fill' | 'click' | 'read' | 'wait';
  /** CSS selector the step targets, or `null` for non-targeted steps. */
  selector: string | null;
  /** What the agent is trying to achieve. */
  intent: string;
  /** Ids of friction traps that make this step unreliable. */
  blockedByTrapIds: string[];
  /** Probability in `[0, 1]` that this step fails on the first attempt. */
  riskScore: number;
}

/** The outcome of an active (or simulated) agent run against the target. */
export interface SyntheticEvaluation {
  /** The high-level goal the synthetic agent was given. */
  goal: string;
  /** Archetype the goal was resolved to. */
  resolvedGoal: BenchmarkGoal;
  /** `webmcp-direct` when tools were available, else `dom-fallback`. */
  mode: 'webmcp-direct' | 'dom-fallback';
  driver: SyntheticDriverKind;
  /** True when a live Playwright page backed the run. */
  live: boolean;
  /** Tool invocations attempted (empty in DOM fallback mode). */
  attempts: ToolInvocationAttempt[];
  /** The DOM plan (empty when a tool handled the goal). */
  plan: DomPlanStep[];
  /** True when the goal was satisfiable by the surface as it exists today. */
  success: boolean;
  /** Model- or heuristic-authored explanation of the outcome. */
  reasoning: string;
  /** Non-fatal problems (missing key, unresolved package, skipped mutation). */
  warnings: string[];
  /** Wall-clock duration of the evaluation. */
  durationMs: number;
}

/* -------------------------------------------------------------------------- */
/* Scorecard                                                                   */
/* -------------------------------------------------------------------------- */

/** Rolled-up counters that describe the scored surface. */
export interface ScorecardSummary {
  /** Tools counted across every discovery channel. */
  toolCount: number;
  /** Tools with a callable runtime handler. */
  executableToolCount: number;
  /** Interactive surfaces classified as critical (search/checkout/auth/signup). */
  criticalSurfaceCount: number;
  /** Critical surfaces backed by at least one registered tool. */
  coveredCriticalSurfaceCount: number;
  /** Critical surfaces reachable only by driving raw DOM. */
  domOnlyCriticalSurfaceCount: number;
  /** Friction traps counted. */
  frictionTrapCount: number;
  /** Issues by severity; all three keys always present. */
  issuesBySeverity: Record<IssueSeverity, number>;
  /** Highest-impact issue id, or `null` when the site is clean. */
  topIssueId: string | null;
}

/** The Phase 2 deliverable. */
export interface AgentScorecard {
  schemaVersion: ScorecardSchemaVersion;
  /** Deterministic id derived from the audited scan. */
  scorecardId: string;
  /** ISO-8601 timestamp; injectable for reproducible tests. */
  generatedAt: string;
  /** The audited target. */
  target: {
    requestedUrl: string;
    finalUrl: string | null;
    origin: string;
    scanId: string;
  };
  /** 0–100, rounded to the nearest integer. */
  overallScore: number;
  /** 0–100 before rounding, for reconciliation against deductions. */
  overallScoreExact: number;
  grade: Grade;
  /** Always four entries, in `discovery, actionability, friction, safety` order. */
  pillars: PillarScore[];
  /** Ranked most-costly-first. */
  issues: AuditIssue[];
  benchmark: BenchmarkComparison;
  /** Present only when an active evaluation was run. */
  syntheticEvaluation: SyntheticEvaluation | null;
  summary: ScorecardSummary;
}

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

/** Tuning knobs for {@link import('./benchmark').estimateBenchmark}. */
export interface BenchmarkOptions {
  /** Transaction archetype to model. Defaults to the target's richest surface. */
  goal?: BenchmarkGoal;
  /** Token prices. Defaults to {@link DEFAULT_PRICING}. */
  pricing?: PricingModel;
  /** Model output throughput in tokens/second. Default 55. */
  outputTokensPerSecond?: number;
  /** Fixed model round-trip overhead in ms. Default 800. */
  modelOverheadMs?: number;
  /** Page action + render latency per DOM step, in ms. Default 1200. */
  domActionLatencyMs?: number;
  /** WebMCP tool execution latency, in ms. Default 250. */
  toolExecutionLatencyMs?: number;
}

/** Tuning knobs for {@link import('./scorer').scoreAudit}. */
export interface ScoringOptions {
  /** Timestamp for {@link AgentScorecard.generatedAt}. Defaults to now. */
  now?: () => Date;
  /** Benchmark configuration. */
  benchmark?: BenchmarkOptions;
  /** Attach an already-computed synthetic evaluation. */
  syntheticEvaluation?: SyntheticEvaluation | null;
}

/** Everything the scorer needs; the raw scan plus optional extras. */
export interface ScoringInput {
  data: AgentAuditRawData;
  options?: ScoringOptions;
}
