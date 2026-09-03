/**
 * AgentGrade — synthetic benchmark and Agent Friction Tax calculator.
 *
 * Models one user transaction two ways: an agent driving the raw DOM, and the
 * same agent calling a registered WebMCP tool. The difference is the "friction
 * tax" — the tokens, dollars, seconds, and failure risk a site imposes on every
 * agent-driven transaction by not exposing tools.
 *
 * These are *estimates*, derived arithmetically from the scan. Every constant
 * is named, exported, and overridable, and every comparison records its
 * assumptions so the numbers can be argued with rather than taken on faith.
 * For exact token counts of a concrete prompt, use `messages.countTokens`.
 */

import type { AgentAuditRawData } from '../scanner/types.js';
import {
  CRITICAL_CATEGORIES,
  CRITICAL_SURFACE_TRAP_MULTIPLIER,
  GOAL_BASE_DOM_STEPS,
  TRAP_FAILURE_HAZARD,
  TRAP_RETRY_STEPS,
  assessSchema,
  clamp,
  estimateToolDefinitionTokens,
  inferPrimaryGoal,
  round,
  safeRatio,
} from './analysis.js';
import {
  DEFAULT_PRICING,
  type BenchmarkComparison,
  type BenchmarkGoal,
  type BenchmarkMode,
  type BenchmarkOptions,
  type FrictionTax,
  type PricingModel,
} from './types.js';

/* -------------------------------------------------------------------------- */
/* Model constants                                                             */
/* -------------------------------------------------------------------------- */

/** Estimator constants. Exported so callers can see exactly what was assumed. */
export const BENCHMARK_CONSTANTS = {
  /** Tokens to serialise one DOM element into a pruned accessibility tree. */
  tokensPerDomNode: 12,
  /** Extra tokens per interactive control (name, role, selector). */
  tokensPerControl: 25,
  /** Extra tokens per catalogued form (fields, labels, action). */
  tokensPerForm: 40,
  /** Floor for a page snapshot: even an empty page costs something to read. */
  minDomSnapshotTokens: 300,
  /** Ceiling: past this an agent is paging, not reading the whole tree. */
  maxDomSnapshotTokens: 120_000,
  /** System prompt + goal framing, charged on every step. */
  systemPromptTokens: 450,
  /** Tokens the model emits per DOM step (a short thought plus one action). */
  domOutputTokensPerStep: 120,
  /** Tokens the model emits to call one tool. */
  toolCallOutputTokens: 80,
  /** Tokens of tool-result observation appended to history after each step. */
  observationTokensPerStep: 60,
  /** Ceiling on friction-induced extra steps: agents give up eventually. */
  maxFrictionSteps: 24,
  /** Per-step chance an agent misreads a well-built page. */
  baseDomStepFailureRate: 0.02,
  /** Floor failure rate for a direct, schema-validated tool call. */
  baseToolFailureRate: 0.01,
  /** Additional tool-call failure risk when schemas are unclear. */
  maxSchemaAmbiguityFailure: 0.12,
  /** Reference schema size used when a site has no tools to measure. */
  referenceToolDefinitionTokens: 120,
  /** Absolute cap on modelled failure probability. */
  maxFailureProbability: 0.95,
} as const;

/** Model round trips a WebMCP call needs, by goal. */
const GOAL_TOOL_STEPS: Readonly<Record<BenchmarkGoal, number>> = {
  search: 1,
  // A purchase realistically needs a confirm turn after the call returns.
  checkout: 2,
  authentication: 1,
  signup: 1,
  generic: 1,
};

const DEFAULT_OUTPUT_TOKENS_PER_SECOND = 55;
const DEFAULT_MODEL_OVERHEAD_MS = 800;
const DEFAULT_DOM_ACTION_LATENCY_MS = 1200;
const DEFAULT_TOOL_EXECUTION_LATENCY_MS = 250;

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Estimates the cost of one transaction in both execution modes.
 *
 * Pure and deterministic: the same {@link AgentAuditRawData} and options always
 * produce the same comparison. Safe on empty or degenerate scans — a page with
 * zero DOM nodes, zero tools, and zero traps still yields finite, bounded
 * numbers rather than `NaN`.
 */
export function estimateBenchmark(
  data: AgentAuditRawData,
  options: BenchmarkOptions = {},
): BenchmarkComparison {
  const goal = options.goal ?? inferPrimaryGoal(data);
  const pricing = options.pricing ?? DEFAULT_PRICING;
  const tokensPerSecond = positive(options.outputTokensPerSecond, DEFAULT_OUTPUT_TOKENS_PER_SECOND);
  const modelOverheadMs = nonNegative(options.modelOverheadMs, DEFAULT_MODEL_OVERHEAD_MS);
  const domActionLatencyMs = nonNegative(options.domActionLatencyMs, DEFAULT_DOM_ACTION_LATENCY_MS);
  const toolExecutionLatencyMs = nonNegative(options.toolExecutionLatencyMs, DEFAULT_TOOL_EXECUTION_LATENCY_MS);

  const assumptions: string[] = [];
  const domTraversal = modelDomTraversal(data, {
    goal,
    pricing,
    tokensPerSecond,
    modelOverheadMs,
    domActionLatencyMs,
    assumptions,
  });
  const webMcpDirect = modelWebMcpDirect(data, {
    goal,
    pricing,
    tokensPerSecond,
    modelOverheadMs,
    toolExecutionLatencyMs,
    assumptions,
  });

  assumptions.push(
    `Costs quoted at ${pricing.model} rates ($${pricing.inputPerMillionUsd}/1M input, $${pricing.outputPerMillionUsd}/1M output).`,
    `Token counts are estimated at ~${BENCHMARK_CONSTANTS.tokensPerDomNode} tokens per DOM node and 4 characters per token, not measured with a tokenizer.`,
    `Model throughput assumed at ${tokensPerSecond} output tokens/second with ${modelOverheadMs}ms of round-trip overhead.`,
  );

  return {
    goal,
    pricing,
    domTraversal,
    webMcpDirect,
    frictionTax: computeFrictionTax(domTraversal, webMcpDirect),
    assumptions,
  };
}

/* -------------------------------------------------------------------------- */
/* DOM traversal baseline                                                      */
/* -------------------------------------------------------------------------- */

interface DomModelContext {
  goal: BenchmarkGoal;
  pricing: PricingModel;
  tokensPerSecond: number;
  modelOverheadMs: number;
  domActionLatencyMs: number;
  assumptions: string[];
}

/**
 * Models an agent completing the goal by reading and clicking the page.
 *
 * Three things drive the cost: the page must be re-serialised into the prompt
 * on every step, the conversation history grows quadratically as observations
 * accumulate, and every friction trap buys extra recovery steps.
 */
function modelDomTraversal(data: AgentAuditRawData, context: DomModelContext): BenchmarkMode {
  const snapshotTokens = estimateDomSnapshotTokens(data);
  const baseSteps = GOAL_BASE_DOM_STEPS[context.goal];
  const frictionSteps = estimateFrictionSteps(data);
  const steps = Math.max(1, Math.ceil(baseSteps + frictionSteps));

  const contextTokensPerStep = BENCHMARK_CONSTANTS.systemPromptTokens + snapshotTokens;
  const outputTokensPerStep = BENCHMARK_CONSTANTS.domOutputTokensPerStep;

  // Every step resends the system prompt and a fresh page snapshot, plus the
  // history of prior actions and observations: sum_{i=0}^{steps-1} i * carry.
  const historyCarryPerStep = outputTokensPerStep + BENCHMARK_CONSTANTS.observationTokensPerStep;
  const historyTokens = (steps * (steps - 1)) / 2 * historyCarryPerStep;
  const inputTokens = Math.round(steps * contextTokensPerStep + historyTokens);
  const outputTokens = Math.round(steps * outputTokensPerStep);

  const modelLatencyMsPerStep = context.modelOverheadMs + (outputTokensPerStep / context.tokensPerSecond) * 1000;
  const latencyMs = Math.round(steps * (modelLatencyMsPerStep + context.domActionLatencyMs));

  const failureProbability = estimateDomFailureProbability(data, steps);

  if (data.page.domNodeCount === 0) {
    context.assumptions.push(
      'The scan recorded no DOM nodes, so the DOM baseline uses the minimum page-snapshot size rather than a measured tree.',
    );
  }

  return {
    mode: 'dom-traversal',
    steps,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd: costOf(inputTokens, outputTokens, context.pricing),
    latencyMs,
    failureProbability,
    expectedRetries: expectedRetries(failureProbability),
    breakdown: {
      contextTokensPerStep,
      outputTokensPerStep,
      baseSteps,
      frictionSteps: round(frictionSteps, 2),
      modelLatencyMsPerStep: Math.round(modelLatencyMsPerStep),
      actionLatencyMsPerStep: context.domActionLatencyMs,
      perStepFailureRate: BENCHMARK_CONSTANTS.baseDomStepFailureRate,
    },
  };
}

/** Tokens needed to put one readable view of the page into a prompt. */
export function estimateDomSnapshotTokens(data: AgentAuditRawData): number {
  const raw =
    data.page.domNodeCount * BENCHMARK_CONSTANTS.tokensPerDomNode +
    data.controls.length * BENCHMARK_CONSTANTS.tokensPerControl +
    data.forms.length * BENCHMARK_CONSTANTS.tokensPerForm;
  return Math.round(
    clamp(raw, BENCHMARK_CONSTANTS.minDomSnapshotTokens, BENCHMARK_CONSTANTS.maxDomSnapshotTokens),
  );
}

/** Extra model round trips the page's friction traps force an agent to spend. */
export function estimateFrictionSteps(data: AgentAuditRawData): number {
  const criticalFormIds = new Set(
    data.forms.filter((form) => CRITICAL_CATEGORIES.has(form.category)).map((form) => form.id),
  );
  let total = 0;
  for (const trap of data.frictionTraps) {
    const base = TRAP_RETRY_STEPS[trap.severity] ?? 0;
    const multiplier = trap.formId && criticalFormIds.has(trap.formId) ? CRITICAL_SURFACE_TRAP_MULTIPLIER : 1;
    total += base * multiplier;
  }
  return clamp(total, 0, BENCHMARK_CONSTANTS.maxFrictionSteps);
}

/**
 * Probability the DOM run fails outright: the agent must survive every step,
 * and must not be defeated by any individual trap along the way.
 */
function estimateDomFailureProbability(data: AgentAuditRawData, steps: number): number {
  let survival = (1 - BENCHMARK_CONSTANTS.baseDomStepFailureRate) ** steps;
  for (const trap of data.frictionTraps) {
    const hazard = TRAP_FAILURE_HAZARD[trap.severity] ?? 0;
    survival *= 1 - hazard;
  }
  return round(clamp(1 - survival, 0, BENCHMARK_CONSTANTS.maxFailureProbability), 4);
}

/* -------------------------------------------------------------------------- */
/* WebMCP direct execution                                                     */
/* -------------------------------------------------------------------------- */

interface ToolModelContext {
  goal: BenchmarkGoal;
  pricing: PricingModel;
  tokensPerSecond: number;
  modelOverheadMs: number;
  toolExecutionLatencyMs: number;
  assumptions: string[];
}

/**
 * Models the same goal executed as a direct tool call.
 *
 * The agent pays once for the tool definitions, emits one call, and reads one
 * structured result. When the site registers no tools at all, this is the
 * theoretical payload it *would* cost, computed against a reference schema —
 * which is exactly the number that makes the friction tax meaningful.
 */
function modelWebMcpDirect(data: AgentAuditRawData, context: ToolModelContext): BenchmarkMode {
  const hasTools = data.tools.length > 0;
  const toolDefinitionTokens = hasTools
    ? clamp(
        data.tools.reduce((total, tool) => total + estimateToolDefinitionTokens(tool), 0),
        0,
        BENCHMARK_CONSTANTS.maxDomSnapshotTokens,
      )
    : BENCHMARK_CONSTANTS.referenceToolDefinitionTokens;

  if (!hasTools) {
    context.assumptions.push(
      'The target registers no WebMCP tools, so the direct-execution column is the theoretical cost against a reference single-tool schema.',
    );
  }

  const steps = GOAL_TOOL_STEPS[context.goal];
  const contextTokensPerStep = Math.round(BENCHMARK_CONSTANTS.systemPromptTokens + toolDefinitionTokens);
  const outputTokensPerStep = BENCHMARK_CONSTANTS.toolCallOutputTokens;

  const historyCarryPerStep = outputTokensPerStep + BENCHMARK_CONSTANTS.observationTokensPerStep;
  const historyTokens = (steps * (steps - 1)) / 2 * historyCarryPerStep;
  const inputTokens = Math.round(steps * contextTokensPerStep + historyTokens);
  const outputTokens = Math.round(steps * outputTokensPerStep);

  const modelLatencyMsPerStep = context.modelOverheadMs + (outputTokensPerStep / context.tokensPerSecond) * 1000;
  const latencyMs = Math.round(steps * (modelLatencyMsPerStep + context.toolExecutionLatencyMs));

  const ambiguity = 1 - schemaClarity(data);
  const failureProbability = round(
    clamp(
      BENCHMARK_CONSTANTS.baseToolFailureRate + BENCHMARK_CONSTANTS.maxSchemaAmbiguityFailure * ambiguity,
      0,
      BENCHMARK_CONSTANTS.maxFailureProbability,
    ),
    4,
  );

  return {
    mode: 'webmcp-direct',
    steps,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd: costOf(inputTokens, outputTokens, context.pricing),
    latencyMs,
    failureProbability,
    expectedRetries: expectedRetries(failureProbability),
    breakdown: {
      contextTokensPerStep,
      outputTokensPerStep,
      baseSteps: steps,
      frictionSteps: 0,
      modelLatencyMsPerStep: Math.round(modelLatencyMsPerStep),
      actionLatencyMsPerStep: context.toolExecutionLatencyMs,
      perStepFailureRate: failureProbability,
    },
  };
}

/**
 * How unambiguously the registered tools describe themselves, in `[0, 1]`.
 * A site with no tools scores `0` — there is nothing for a model to get right.
 */
export function schemaClarity(data: AgentAuditRawData): number {
  if (data.tools.length === 0) return 0;
  let total = 0;
  for (const tool of data.tools) {
    const quality = assessSchema(tool);
    const described = tool.description ? 0.3 : 0;
    const structured = quality.isStructured ? 0.3 : 0;
    const typed = quality.allParametersTyped ? 0.2 : 0;
    const documented = 0.2 * quality.parameterDescriptionRatio;
    total += described + structured + typed + documented;
  }
  return round(safeRatio(total, data.tools.length), 4);
}

/* -------------------------------------------------------------------------- */
/* Friction tax                                                                */
/* -------------------------------------------------------------------------- */

/** Difference between the two modes — the cost of not shipping WebMCP. */
export function computeFrictionTax(dom: BenchmarkMode, webMcp: BenchmarkMode): FrictionTax {
  const tokensWasted = Math.max(0, dom.totalTokens - webMcp.totalTokens);
  const costWastedUsd = round(Math.max(0, dom.costUsd - webMcp.costUsd), 4);
  const latencyWastedMs = Math.max(0, dom.latencyMs - webMcp.latencyMs);
  const secondsWasted = round(latencyWastedMs / 1000, 1);
  const failureProbabilityDelta = round(Math.max(0, dom.failureProbability - webMcp.failureProbability), 4);
  const tokenMultiple = webMcp.totalTokens > 0 ? round(dom.totalTokens / webMcp.totalTokens, 1) : null;

  return {
    tokensWasted,
    costWastedUsd,
    latencyWastedMs,
    secondsWasted,
    failureProbabilityDelta,
    tokenMultiple,
    headline: formatHeadline(costWastedUsd, secondsWasted, failureProbabilityDelta),
  };
}

/** Renders the tax as the one sentence a stakeholder will actually remember. */
function formatHeadline(costUsd: number, seconds: number, failureDelta: number): string {
  const money = costUsd >= 0.01 ? `$${costUsd.toFixed(2)}` : `$${costUsd.toFixed(4)}`;
  const failure = `${round(failureDelta * 100, 1)}% more likely to fail`;
  return `${money} and ${seconds.toFixed(1)}s wasted per user transaction without WebMCP, and ${failure}.`;
}

/* -------------------------------------------------------------------------- */
/* Arithmetic helpers                                                          */
/* -------------------------------------------------------------------------- */

/** USD cost of a token split at the given prices. Never returns `NaN`. */
export function costOf(inputTokens: number, outputTokens: number, pricing: PricingModel): number {
  const input = (Math.max(0, inputTokens) / 1_000_000) * Math.max(0, pricing.inputPerMillionUsd);
  const output = (Math.max(0, outputTokens) / 1_000_000) * Math.max(0, pricing.outputPerMillionUsd);
  return round(input + output, 6);
}

/**
 * Expected number of retries implied by a per-attempt failure probability,
 * `p / (1 - p)`, capped so a near-certain failure does not diverge.
 */
function expectedRetries(failureProbability: number): number {
  const p = clamp(failureProbability, 0, BENCHMARK_CONSTANTS.maxFailureProbability);
  return round(Math.min(20, p / Math.max(1e-6, 1 - p)), 2);
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegative(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}
