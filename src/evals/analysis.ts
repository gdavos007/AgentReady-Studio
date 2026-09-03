/**
 * AgentGrade — shared derivations for the Phase 2 evaluators.
 *
 * The scorer, the benchmark, the issue synthesizer, and the synthetic agent all
 * need the same handful of judgements: is this tool a query or a mutation, does
 * any registered tool actually back this checkout form, how many tokens is this
 * schema. They live here once so the four modules cannot drift apart.
 */

import type {
  AgentAuditRawData,
  DiscoveredForm,
  FormCategory,
  FrictionTrap,
  JsonValue,
  RegisteredTool,
  TrapSeverity,
} from '../scanner/types.js';
import type { BenchmarkGoal } from './types.js';

/* -------------------------------------------------------------------------- */
/* Token estimation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Characters per token. A deliberately coarse heuristic: the benchmark models a
 * transaction that has not happened yet, so an exact tokenizer would imply a
 * precision the estimate does not have. When an API key is available,
 * `client.messages.countTokens` gives exact counts for a concrete prompt.
 */
export const CHARS_PER_TOKEN = 4;

/** Estimated token count of a string. Always a non-negative integer. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/** Estimated token count of a JSON-serialisable value. */
export function estimateJsonTokens(value: JsonValue | null | undefined): number {
  if (value === null || value === undefined) return 0;
  try {
    return estimateTokens(JSON.stringify(value));
  } catch {
    return 0;
  }
}

/**
 * Tokens needed to describe one tool to a model: name, description, and the
 * full input schema, plus the framing the API adds around a tool definition.
 */
export function estimateToolDefinitionTokens(tool: RegisteredTool): number {
  const TOOL_FRAMING_TOKENS = 12;
  return (
    TOOL_FRAMING_TOKENS +
    estimateTokens(tool.name) +
    estimateTokens(tool.description ?? '') +
    estimateJsonTokens(tool.inputSchema.raw)
  );
}

/* -------------------------------------------------------------------------- */
/* Numeric guards                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Clamps `value` into `[min, max]`. Infinities saturate at the nearer bound;
 * only `NaN` — which carries no ordering at all — falls back to `min`.
 */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * `numerator / denominator` guarded against division by zero and NaN.
 * An empty denominator yields `fallback` (default `0`) rather than `NaN`.
 */
export function safeRatio(numerator: number, denominator: number, fallback = 0): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return fallback;
  return clamp(numerator / denominator, 0, 1);
}

/** Rounds to `digits` decimal places, mapping non-finite input to `0`. */
export function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/* -------------------------------------------------------------------------- */
/* Tool classification                                                         */
/* -------------------------------------------------------------------------- */

/** Whether a tool reads state or changes it. */
export type ToolKind = 'query' | 'mutation' | 'unknown';

/**
 * Verb vocabulary for classifying tools.
 *
 * Three passes, because the signals are not equally reliable:
 *
 *  1. **Leading verb of the name.** Tool names are conventionally `verb_noun`,
 *     so the first word is the strongest signal there is. This pass exists
 *     because `get_order_status` is a query whose *name* contains "order".
 *  2. **Anywhere in the name.** Catches `start_return`, `cart_add`.
 *  3. **The description.** Weakest, and scanned with a narrower vocabulary:
 *     "return", "order", "post", "set" and "apply" are so common in ordinary
 *     prose ("returns the matching issues", "in order to") that matching them
 *     in a description produces more false mutations than true ones.
 */
const LEADING_MUTATION_VERBS = new Set([
  'add', 'create', 'update', 'delete', 'remove', 'place', 'submit', 'buy', 'purchase',
  'checkout', 'pay', 'book', 'cancel', 'subscribe', 'register', 'apply', 'set', 'send',
  'post', 'transfer', 'refund', 'save', 'edit', 'upload', 'schedule', 'order',
]);

const LEADING_QUERY_VERBS = new Set([
  'get', 'list', 'search', 'find', 'read', 'fetch', 'lookup', 'query', 'show', 'view',
  'browse', 'check', 'track', 'describe', 'inspect', 'quote', 'calculate', 'filter',
  'select', 'export', 'preview', 'compare', 'estimate', 'count', 'resolve', 'summarize',
]);

const MUTATION_VERBS =
  /\b(add|create|update|delete|remove|place|submit|buy|purchase|checkout|pay|order|book|cancel|subscribe|register|sign[_\s-]?up|apply|set|send|post|transfer|refund|return)\b/i;

/** Description vocabulary: the prose-colliding verbs are deliberately absent. */
const MUTATION_VERBS_IN_PROSE =
  /\b(add|create|update|delete|remove|place|submit|buy|purchase|checkout|pay|book|cancel|subscribe|sign[_\s-]?up|send|transfer|refund)\b/i;

const QUERY_VERBS =
  /\b(get|list|search|find|read|fetch|lookup|look[_\s-]?up|query|show|view|browse|check|track|status|describe|inspect|quote|calculate|filter|select|export|preview)\b/i;

/** The leading word of a tool name, lowercased. */
function leadingVerb(name: string): string {
  return (name.replace(/[_-]+/g, ' ').trim().split(/\s+/)[0] ?? '').toLowerCase();
}

/**
 * Classifies a tool as a query or a mutation from its name, description, and
 * annotations. Annotations win when present — they are the author's own claim.
 */
export function classifyTool(tool: RegisteredTool): ToolKind {
  const readOnlyHint = tool.annotations['readOnlyHint'];
  if (readOnlyHint === true) return 'query';
  if (readOnlyHint === false) return 'mutation';
  if (tool.annotations['destructiveHint'] === true) return 'mutation';

  return classifyByVerbs(tool.name, tool.description ?? '');
}

/** The three-pass verb classification shared by both entry points. */
function classifyByVerbs(rawName: string, description: string): ToolKind {
  const leading = leadingVerb(rawName);
  if (LEADING_MUTATION_VERBS.has(leading)) return 'mutation';
  if (LEADING_QUERY_VERBS.has(leading)) return 'query';

  const name = rawName.replace(/[_-]+/g, ' ');
  if (MUTATION_VERBS.test(name)) return 'mutation';
  if (QUERY_VERBS.test(name)) return 'query';

  if (MUTATION_VERBS_IN_PROSE.test(description)) return 'mutation';
  if (QUERY_VERBS.test(description)) return 'query';
  return 'unknown';
}

/**
 * Classifies a tool from its name and description *only*, ignoring the author's
 * annotations. The safety pillar needs this to detect a mislabelled tool — a
 * `readOnlyHint: true` sitting on something called `place_order`.
 */
export function classifyToolByLanguage(tool: RegisteredTool): ToolKind {
  return classifyByVerbs(tool.name, tool.description ?? '');
}

/** True when a tool is safe to invoke during an audit without side effects. */
export function isReadOnlyTool(tool: RegisteredTool): boolean {
  return tool.annotations['readOnlyHint'] === true || classifyTool(tool) === 'query';
}

/** Structural quality of a tool's declared input schema. */
export interface SchemaQuality {
  /** Schema declares a `type` and/or properties. */
  isStructured: boolean;
  /** Number of declared top-level parameters. */
  parameterCount: number;
  /** Parameters carrying a non-empty `description`. */
  describedParameterCount: number;
  /** `describedParameterCount / parameterCount`, or `0` when there are none. */
  parameterDescriptionRatio: number;
  /** Schema declares which parameters are required. */
  declaresRequired: boolean;
  /** Every declared parameter has a `type`. */
  allParametersTyped: boolean;
}

/** Inspects a tool's `inputSchema.raw` for the properties agents rely on. */
export function assessSchema(tool: RegisteredTool): SchemaQuality {
  const raw = tool.inputSchema.raw;
  const properties =
    raw && typeof raw === 'object' && !Array.isArray(raw) && raw.properties && typeof raw.properties === 'object' && !Array.isArray(raw.properties)
      ? (raw.properties as Record<string, JsonValue>)
      : null;

  const entries = properties ? Object.entries(properties) : [];
  let described = 0;
  let typed = 0;
  for (const [, value] of entries) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, JsonValue>;
      if (typeof record.description === 'string' && record.description.trim().length > 0) described++;
      if (typeof record.type === 'string' || Array.isArray(record.type) || record.enum || record.$ref) typed++;
    }
  }

  return {
    isStructured: tool.inputSchema.isStructured,
    parameterCount: entries.length,
    describedParameterCount: described,
    parameterDescriptionRatio: safeRatio(described, entries.length),
    declaresRequired: tool.inputSchema.required.length > 0,
    allParametersTyped: entries.length > 0 && typed === entries.length,
  };
}

/** A description is "clear" when it is a sentence, not a restated identifier. */
export function hasClearDescription(tool: RegisteredTool): boolean {
  const description = (tool.description ?? '').trim();
  if (description.length < 15) return false;
  if (description.split(/\s+/).length < 3) return false;
  // A description that merely echoes the tool name teaches an agent nothing.
  const normalisedName = tool.name.replace(/[_-]+/g, ' ').toLowerCase();
  return description.toLowerCase().replace(/[^a-z ]+/g, '').trim() !== normalisedName;
}

/* -------------------------------------------------------------------------- */
/* Surface coverage                                                            */
/* -------------------------------------------------------------------------- */

/** Surface categories an agent is most often asked to drive. */
export const CRITICAL_CATEGORIES: ReadonlySet<FormCategory> = new Set<FormCategory>([
  'search',
  'checkout',
  'authentication',
  'signup',
]);

/** Keywords that tie a registered tool to the surface it would replace. */
const CATEGORY_KEYWORDS: Readonly<Record<FormCategory, readonly string[]>> = {
  search: ['search', 'find', 'query', 'lookup', 'browse', 'catalog', 'products'],
  checkout: ['checkout', 'cart', 'order', 'purchase', 'buy', 'pay', 'payment', 'basket', 'shipping'],
  authentication: ['login', 'log in', 'signin', 'sign in', 'auth', 'session', 'credential'],
  signup: ['signup', 'sign up', 'register', 'create account', 'enroll'],
  contact: ['contact', 'support', 'message', 'ticket', 'feedback'],
  newsletter: ['newsletter', 'subscribe', 'mailing', 'digest'],
  filter: ['filter', 'sort', 'refine', 'facet'],
  'modal-trigger': ['dialog', 'modal', 'help'],
  generic: [],
};

/** Whether — and how — a registered tool covers an interactive surface. */
export interface SurfaceCoverage {
  form: DiscoveredForm;
  /** True when this surface is one an agent is likely to be asked to drive. */
  critical: boolean;
  /** Tools judged to back this surface. */
  coveringTools: RegisteredTool[];
  /** How the match was made. `null` when uncovered. */
  matchedBy: 'annotation' | 'selector' | 'keyword' | null;
  /** True when the only way to use this surface is to drive raw DOM. */
  domOnly: boolean;
}

/**
 * Decides whether `tool` backs `form`.
 *
 * Three signals, strongest first: an explicit `data-mcp-tool` annotation naming
 * the tool, a declarative tool whose selector points inside the form, and a
 * keyword match between the tool's name/description and the surface category.
 */
function matchTool(form: DiscoveredForm, tool: RegisteredTool): SurfaceCoverage['matchedBy'] | null {
  const annotatedName = form.mcpAnnotated ? formAnnotationName(form) : null;
  if (annotatedName && annotatedName === tool.name.toLowerCase()) return 'annotation';

  if (tool.selector && (tool.selector === form.selector || tool.selector.startsWith(form.selector))) {
    return 'selector';
  }

  const keywords = CATEGORY_KEYWORDS[form.category] ?? [];
  if (keywords.length === 0) return null;
  const haystack = `${tool.name.replace(/[_-]+/g, ' ')} ${tool.description ?? ''}`.toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword)) ? 'keyword' : null;
}

/** Reads the tool name a form claims to be backed by, if any. */
function formAnnotationName(form: DiscoveredForm): string | null {
  // The scanner records the annotation on the declarative tag; the form itself
  // exposes only the boolean. Fall back to the form's own name when present.
  const candidate = (form.name ?? '').trim().toLowerCase();
  return candidate.length > 0 ? candidate : null;
}

/**
 * Maps every discovered surface to the tools that cover it.
 *
 * A surface annotated with `data-mcp-tool` is treated as covered even when no
 * matching tool name is registered: the author declared the binding, and the
 * missing registration is reported separately as a safety issue.
 */
export function deriveSurfaceCoverage(data: AgentAuditRawData): SurfaceCoverage[] {
  const tools = data.tools;
  return data.forms.map((form) => {
    const coveringTools: RegisteredTool[] = [];
    let matchedBy: SurfaceCoverage['matchedBy'] = null;

    for (const tool of tools) {
      const match = matchTool(form, tool);
      if (!match) continue;
      coveringTools.push(tool);
      // Keep the strongest match seen.
      if (match === 'annotation' || (match === 'selector' && matchedBy !== 'annotation') || matchedBy === null) {
        matchedBy = match;
      }
    }

    if (coveringTools.length === 0 && form.mcpAnnotated) {
      matchedBy = 'annotation';
    }

    const covered = coveringTools.length > 0 || form.mcpAnnotated;
    const critical = CRITICAL_CATEGORIES.has(form.category);
    return {
      form,
      critical,
      coveringTools,
      matchedBy: covered ? matchedBy : null,
      domOnly: !covered,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Friction weighting                                                          */
/* -------------------------------------------------------------------------- */

/** Penalty points per trap, by severity, used by the friction pillar. */
export const TRAP_SEVERITY_WEIGHT: Readonly<Record<TrapSeverity, number>> = {
  critical: 12,
  high: 7,
  medium: 3,
  low: 1,
};

/**
 * Per-step probability that a trap defeats an agent mid-transaction. Used by
 * the benchmark, not the score — these are failure hazards, not penalties.
 */
export const TRAP_FAILURE_HAZARD: Readonly<Record<TrapSeverity, number>> = {
  critical: 0.35,
  high: 0.18,
  medium: 0.07,
  low: 0.02,
};

/** Extra model round trips a trap forces an agent to spend recovering. */
export const TRAP_RETRY_STEPS: Readonly<Record<TrapSeverity, number>> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0.5,
};

/** Multiplier applied to a trap sitting inside a critical surface. */
export const CRITICAL_SURFACE_TRAP_MULTIPLIER = 1.5;

/** Total severity-weighted friction, amplified inside critical surfaces. */
export function weightedTrapPenalty(data: AgentAuditRawData): number {
  const criticalFormIds = new Set(
    data.forms.filter((form) => CRITICAL_CATEGORIES.has(form.category)).map((form) => form.id),
  );
  let total = 0;
  for (const trap of data.frictionTraps) {
    const base = TRAP_SEVERITY_WEIGHT[trap.severity] ?? 0;
    const multiplier = trap.formId && criticalFormIds.has(trap.formId) ? CRITICAL_SURFACE_TRAP_MULTIPLIER : 1;
    total += base * multiplier;
  }
  return round(total, 2);
}

/** Groups traps by type, preserving the scanner's ordering within each group. */
export function groupTrapsByType(traps: FrictionTrap[]): Map<FrictionTrap['type'], FrictionTrap[]> {
  const grouped = new Map<FrictionTrap['type'], FrictionTrap[]>();
  for (const trap of traps) {
    const bucket = grouped.get(trap.type);
    if (bucket) bucket.push(trap);
    else grouped.set(trap.type, [trap]);
  }
  return grouped;
}

/* -------------------------------------------------------------------------- */
/* Goal resolution                                                             */
/* -------------------------------------------------------------------------- */

const GOAL_PATTERNS: ReadonlyArray<{ goal: BenchmarkGoal; pattern: RegExp }> = [
  { goal: 'checkout', pattern: /checkout|cart|purchase|buy|order|payment|pay\b/i },
  { goal: 'authentication', pattern: /log\s?in|login|sign\s?in|authenticate|password/i },
  { goal: 'signup', pattern: /sign\s?up|register|create\s+an?\s+account/i },
  { goal: 'search', pattern: /search|find|look\s?up|query|browse/i },
];

/** Maps a free-text goal onto the archetype the benchmark models. */
export function resolveGoal(goal: string): BenchmarkGoal {
  for (const { goal: archetype, pattern } of GOAL_PATTERNS) {
    if (pattern.test(goal)) return archetype;
  }
  return 'generic';
}

/**
 * Picks the transaction archetype a target is most worth benchmarking:
 * the highest-value critical surface it actually exposes.
 */
export function inferPrimaryGoal(data: AgentAuditRawData): BenchmarkGoal {
  const categories = new Set(data.forms.map((form) => form.category));
  if (categories.has('checkout')) return 'checkout';
  if (categories.has('signup')) return 'signup';
  if (categories.has('authentication')) return 'authentication';
  if (categories.has('search')) return 'search';
  return 'generic';
}

/** Base model round trips a goal needs when driving raw DOM. */
export const GOAL_BASE_DOM_STEPS: Readonly<Record<BenchmarkGoal, number>> = {
  search: 4,
  checkout: 9,
  authentication: 5,
  signup: 6,
  generic: 5,
};
