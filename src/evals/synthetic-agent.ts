/**
 * AgentGrade — active synthetic evaluator.
 *
 * Gives a synthetic agent a high-level goal ("execute product search",
 * "inspect checkout flow") and reports what actually happens:
 *
 * - When the target registers WebMCP tools, the evaluator selects one,
 *   synthesizes arguments from its declared input schema, and — if a live
 *   Playwright page is supplied — invokes it for real.
 * - When it registers none, the evaluator falls back to the DOM plan an agent
 *   would be forced to execute instead, annotated with the friction traps that
 *   would break each step.
 *
 * Tool selection runs through a pluggable driver. The evaluator resolves, in
 * order: a caller-supplied driver, the Vercel AI SDK (`ai` + `@ai-sdk/anthropic`),
 * the Anthropic SDK (`@anthropic-ai/sdk`), and finally a deterministic simulated
 * driver. The simulated driver needs no network and no credentials, which is
 * what keeps this module testable and CI-safe.
 *
 * **Mutation safety.** Registered tools are real: `place_order` places an order.
 * Live invocation is therefore restricted to tools classified read-only unless
 * the caller explicitly opts in with `allowMutations`.
 */

import type { AgentAuditRawData, DiscoveredForm, JsonValue, RegisteredTool } from '../scanner/types.js';
import {
  classifyTool,
  isReadOnlyTool,
  resolveGoal,
  round,
  type ToolKind,
} from './analysis.js';
import type {
  BenchmarkGoal,
  DomPlanStep,
  SyntheticDriverKind,
  SyntheticEvaluation,
  ToolInvocationAttempt,
} from './types.js';

/** Default model for the live drivers. */
export const DEFAULT_SYNTHETIC_MODEL = 'claude-opus-5';

/* -------------------------------------------------------------------------- */
/* Driver contract                                                             */
/* -------------------------------------------------------------------------- */

/** What the evaluator asks a driver to decide. */
export interface ToolSelectionRequest {
  /** The caller's high-level goal, verbatim. */
  goal: string;
  /** Archetype the goal resolved to. */
  resolvedGoal: BenchmarkGoal;
  /** Tools available on the target. */
  tools: RegisteredTool[];
  /** Compact description of the page, for drivers that need context. */
  pageSummary: string;
}

/** A driver's answer. */
export interface ToolSelection {
  /** Name of the selected tool, or `null` when no tool fits the goal. */
  toolName: string | null;
  /** Arguments to invoke it with. */
  arguments: Record<string, JsonValue>;
  /** Why this tool (or why none). */
  reasoning: string;
}

/** Pluggable tool-selection backend. */
export interface SyntheticAgentDriver {
  readonly kind: SyntheticDriverKind;
  selectTool(request: ToolSelectionRequest): Promise<ToolSelection>;
}

/**
 * Minimal structural view of a Playwright `Page`, so callers can pass one
 * without this module importing Playwright.
 */
export interface PageLike {
  evaluate<R, A>(pageFunction: (argument: A) => R | Promise<R>, argument: A): Promise<R>;
}

/** Options for {@link runSyntheticEvaluation}. */
export interface SyntheticEvaluationOptions {
  /** High-level goal. Default: `"Execute the site's primary transaction"`. */
  goal?: string;
  /** Live page to invoke tools against. Omit for a dry run. */
  page?: PageLike | null;
  /** Explicit driver; skips auto-resolution. */
  driver?: SyntheticAgentDriver;
  /**
   * Permit invoking tools that mutate state. Default `false` — an audit must
   * not place orders, send mail, or create accounts on someone's live site.
   */
  allowMutations?: boolean;
  /** Model id for the live drivers. Default {@link DEFAULT_SYNTHETIC_MODEL}. */
  model?: string;
  /** Timeout for a single live tool invocation, in ms. Default 10_000. */
  invocationTimeoutMs?: number;
  /** Clock injection, for reproducible durations in tests. */
  now?: () => number;
  /** Set `false` to skip live-driver resolution entirely. Default `true`. */
  useLiveDriver?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Runs a synthetic agent against an audited target.
 *
 * Never throws: driver failures, unresolved packages, missing credentials, and
 * failed invocations all land in `warnings` or on the attempt record.
 */
export async function runSyntheticEvaluation(
  data: AgentAuditRawData,
  options: SyntheticEvaluationOptions = {},
): Promise<SyntheticEvaluation> {
  const clock = options.now ?? (() => Date.now());
  const startedAt = clock();
  const goal = options.goal ?? "Execute the site's primary transaction";
  const resolvedGoal = resolveGoal(goal);
  const warnings: string[] = [];

  const { driver, driverWarnings } = await resolveDriver(options);
  warnings.push(...driverWarnings);

  if (data.tools.length === 0) {
    const plan = buildDomPlan(data, resolvedGoal);
    return {
      goal,
      resolvedGoal,
      mode: 'dom-fallback',
      driver: driver.kind,
      live: false,
      attempts: [],
      plan,
      success: false,
      reasoning:
        `The target registers no WebMCP tools, so the goal "${goal}" can only be attempted by driving the DOM. ` +
        `That path is ${plan.length} step(s) long and ${describePlanRisk(plan)}.`,
      warnings,
      durationMs: Math.max(0, clock() - startedAt),
    };
  }

  let selection: ToolSelection;
  try {
    selection = await driver.selectTool({
      goal,
      resolvedGoal,
      tools: data.tools,
      pageSummary: summarisePage(data),
    });
  } catch (error) {
    warnings.push(`${driver.kind} driver failed (${messageOf(error)}); falling back to deterministic selection.`);
    selection = new SimulatedDriver().selectToolSync({
      goal,
      resolvedGoal,
      tools: data.tools,
      pageSummary: summarisePage(data),
    });
  }

  const tool = selection.toolName
    ? data.tools.find((candidate) => candidate.name === selection.toolName) ?? null
    : null;

  if (!tool) {
    const plan = buildDomPlan(data, resolvedGoal);
    return {
      goal,
      resolvedGoal,
      mode: 'dom-fallback',
      driver: driver.kind,
      live: false,
      attempts: [],
      plan,
      success: false,
      reasoning:
        selection.reasoning ||
        `${data.tools.length} tool(s) are registered but none of them serve the goal "${goal}", so an agent falls back to the DOM.`,
      warnings,
      durationMs: Math.max(0, clock() - startedAt),
    };
  }

  const attempt = await attemptInvocation(tool, selection.arguments, options, warnings, clock);

  return {
    goal,
    resolvedGoal,
    mode: 'webmcp-direct',
    driver: driver.kind,
    live: attempt.execution === 'executed',
    attempts: [attempt],
    plan: [],
    // A live run succeeds only if it actually returned; a dry run can claim no
    // more than that the synthesized call satisfies the declared schema.
    success:
      attempt.execution === 'executed'
        ? attempt.error === null
        : attempt.execution === 'error'
          ? false
          : attempt.schemaSatisfied,
    reasoning: selection.reasoning,
    warnings,
    durationMs: Math.max(0, clock() - startedAt),
  };
}

/* -------------------------------------------------------------------------- */
/* Invocation                                                                  */
/* -------------------------------------------------------------------------- */

async function attemptInvocation(
  tool: RegisteredTool,
  args: Record<string, JsonValue>,
  options: SyntheticEvaluationOptions,
  warnings: string[],
  clock: () => number,
): Promise<ToolInvocationAttempt> {
  const readOnly = isReadOnlyTool(tool);
  const schemaSatisfied = satisfiesSchema(tool, args);

  const base: ToolInvocationAttempt = {
    toolName: tool.name,
    source: tool.source,
    arguments: args,
    execution: 'dry-run',
    result: null,
    error: null,
    durationMs: 0,
    readOnly,
    schemaSatisfied,
  };

  if (!options.page) return base;

  if (!readOnly && !options.allowMutations) {
    warnings.push(
      `Skipped live invocation of "${tool.name}": it is classified as a mutation and \`allowMutations\` was not set.`,
    );
    return { ...base, execution: 'skipped-mutating' };
  }

  if (!tool.executable) {
    warnings.push(`Skipped live invocation of "${tool.name}": it is declared but exposes no callable handler.`);
    return { ...base, execution: 'skipped-mutating' };
  }

  const startedAt = clock();
  try {
    const outcome = await options.page.evaluate(invokeToolInPage, {
      toolName: tool.name,
      args: args as Record<string, unknown>,
      timeoutMs: options.invocationTimeoutMs ?? 10_000,
    });
    return {
      ...base,
      execution: outcome.ok ? 'executed' : 'error',
      result: (outcome.result ?? null) as JsonValue | null,
      error: outcome.ok ? null : outcome.error,
      durationMs: Math.max(0, clock() - startedAt),
    };
  } catch (error) {
    return {
      ...base,
      execution: 'error',
      error: messageOf(error),
      durationMs: Math.max(0, clock() - startedAt),
    };
  }
}

/**
 * Invokes a registered tool inside the page.
 *
 * Serialised by Playwright, so it must be entirely self-contained — no imports,
 * no closures. Returns a JSON-safe envelope rather than throwing.
 */
function invokeToolInPage(input: {
  toolName: string;
  args: Record<string, unknown>;
  timeoutMs: number;
}): Promise<{ ok: boolean; result: unknown; error: string | null }> {
  const hosts: unknown[] = [];
  try {
    hosts.push((navigator as unknown as { modelContext?: unknown }).modelContext);
  } catch {
    /* ignore */
  }
  try {
    hosts.push((document as unknown as { modelContext?: unknown }).modelContext);
  } catch {
    /* ignore */
  }

  const collect = (host: any): any[] => {
    const found: any[] = [];
    for (const key of ['tools', 'availableTools', 'registeredTools', '_tools']) {
      try {
        const value = host[key];
        if (Array.isArray(value)) found.push(...value);
      } catch {
        /* ignore hostile getters */
      }
    }
    for (const key of ['getTools', 'listTools']) {
      try {
        if (typeof host[key] === 'function') {
          const value = host[key]();
          if (Array.isArray(value)) found.push(...value);
        }
      } catch {
        /* ignore */
      }
    }
    return found;
  };

  let target: any = null;
  for (const host of hosts) {
    if (!host || typeof host !== 'object') continue;
    for (const candidate of collect(host)) {
      if (candidate && typeof candidate === 'object' && candidate.name === input.toolName) {
        target = candidate;
        break;
      }
    }
    if (target) break;
  }

  if (!target) {
    return Promise.resolve({ ok: false, result: null, error: `Tool "${input.toolName}" is not present at runtime.` });
  }

  const handlerKey = ['execute', 'handler', 'callback', 'invoke', 'run', 'call'].find(
    (key) => typeof target[key] === 'function',
  );
  if (!handlerKey) {
    return Promise.resolve({ ok: false, result: null, error: `Tool "${input.toolName}" exposes no callable handler.` });
  }

  const safe = (value: unknown, depth: number): unknown => {
    if (value === null) return null;
    const kind = typeof value;
    if (kind === 'string') return (value as string).slice(0, 4000);
    if (kind === 'number') return Number.isFinite(value as number) ? value : null;
    if (kind === 'boolean') return value;
    if (kind !== 'object' || depth > 6) return null;
    if (Array.isArray(value)) return value.slice(0, 50).map((entry) => safe(entry, depth + 1));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).slice(0, 50)) {
      const entry = (value as Record<string, unknown>)[key];
      if (typeof entry === 'function' || typeof entry === 'undefined') continue;
      out[key] = safe(entry, depth + 1);
    }
    return out;
  };

  const timeout = new Promise<{ ok: boolean; result: unknown; error: string | null }>((resolve) => {
    setTimeout(
      () => resolve({ ok: false, result: null, error: `Tool "${input.toolName}" did not settle in ${input.timeoutMs}ms.` }),
      input.timeoutMs,
    );
  });

  const invocation = (async () => {
    try {
      const result = await target[handlerKey](input.args);
      return { ok: true, result: safe(result, 0), error: null };
    } catch (error) {
      return {
        ok: false,
        result: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  })();

  return Promise.race([invocation, timeout]);
}

/* -------------------------------------------------------------------------- */
/* Simulated driver                                                            */
/* -------------------------------------------------------------------------- */

/** Keywords that tie a goal archetype to a tool name or description. */
const GOAL_KEYWORDS: Readonly<Record<BenchmarkGoal, readonly string[]>> = {
  search: ['search', 'find', 'query', 'lookup', 'browse', 'list', 'catalog'],
  checkout: ['checkout', 'order', 'cart', 'purchase', 'buy', 'pay', 'basket'],
  authentication: ['login', 'signin', 'sign in', 'auth', 'session'],
  signup: ['signup', 'sign up', 'register', 'account'],
  generic: [],
};

/**
 * Deterministic, offline tool selection.
 *
 * Scores each tool on keyword overlap with the goal, then prefers the one with
 * the most usable schema. Used whenever no live model is available — and as the
 * fallback whenever a live driver errors, so an evaluation always produces a
 * result.
 */
export class SimulatedDriver implements SyntheticAgentDriver {
  readonly kind: SyntheticDriverKind = 'simulated';

  async selectTool(request: ToolSelectionRequest): Promise<ToolSelection> {
    return this.selectToolSync(request);
  }

  /** Synchronous form, so the async driver path can reuse it as a fallback. */
  selectToolSync(request: ToolSelectionRequest): ToolSelection {
    const keywords = GOAL_KEYWORDS[request.resolvedGoal];
    const goalWords = request.goal
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3);

    // The tool's *name* is what an author chose to call the action, so it
    // outweighs the description — otherwise `place_order`, whose description
    // mentions the cart, outranks `add_to_cart` for "add an item to the cart".
    const scored = request.tools.map((tool) => {
      const name = tool.name.replace(/[_-]+/g, ' ').toLowerCase();
      const description = (tool.description ?? '').toLowerCase();
      let relevance = 0;
      for (const keyword of keywords) {
        if (name.includes(keyword)) relevance += 6;
        if (description.includes(keyword)) relevance += 2;
      }
      for (const word of goalWords) {
        if (name.includes(word)) relevance += 4;
        if (description.includes(word)) relevance += 1;
      }
      // Callability and schema quality break ties; they never make an
      // irrelevant tool eligible.
      const tieBreak = (tool.executable ? 1 : 0) + (tool.inputSchema.isStructured ? 1 : 0);
      return { tool, relevance, score: relevance + tieBreak };
    });

    // Stable ordering: score, then executable, then name.
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.tool.executable) - Number(a.tool.executable) ||
        a.tool.name.localeCompare(b.tool.name),
    );

    const best = scored[0];
    if (!best || best.relevance <= 0) {
      return {
        toolName: null,
        arguments: {},
        reasoning: `None of the ${request.tools.length} registered tool(s) match the goal "${request.goal}" by name or description.`,
      };
    }

    const args = synthesizeArguments(best.tool, request.goal);
    return {
      toolName: best.tool.name,
      arguments: args,
      reasoning:
        `Selected "${best.tool.name}" for the goal "${request.goal}" (match score ${best.score}). ` +
        `Arguments were synthesized from its declared input schema: ${JSON.stringify(args)}.`,
    };
  }
}

/**
 * Builds plausible arguments for a tool from its input schema.
 *
 * Deterministic by construction — the same schema always yields the same
 * values, so a synthetic evaluation can be asserted on in tests.
 */
export function synthesizeArguments(tool: RegisteredTool, goal: string): Record<string, JsonValue> {
  const raw = tool.inputSchema.raw;
  const properties =
    raw && typeof raw === 'object' && !Array.isArray(raw) && raw.properties && typeof raw.properties === 'object' && !Array.isArray(raw.properties)
      ? (raw.properties as Record<string, JsonValue>)
      : null;

  if (!properties) return {};

  const required = new Set(tool.inputSchema.required);
  const args: Record<string, JsonValue> = {};

  for (const [name, definition] of Object.entries(properties)) {
    // Optional parameters are omitted: a minimal call is the honest test of
    // whether the schema declares everything the handler actually needs.
    if (required.size > 0 && !required.has(name)) continue;
    args[name] = synthesizeValue(name, definition, goal);
  }

  // A schema with no `required` list still needs a call to be made with
  // something, so fall back to the first parameter.
  if (Object.keys(args).length === 0) {
    const [firstName, firstDefinition] = Object.entries(properties)[0] ?? [];
    if (firstName) args[firstName] = synthesizeValue(firstName, firstDefinition as JsonValue, goal);
  }

  return args;
}

function synthesizeValue(name: string, definition: JsonValue, goal: string): JsonValue {
  const schema =
    definition && typeof definition === 'object' && !Array.isArray(definition)
      ? (definition as Record<string, JsonValue>)
      : {};

  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  const type = typeof schema.type === 'string' ? schema.type : inferTypeFromName(name);
  const format = typeof schema.format === 'string' ? schema.format : '';
  const lowerName = name.toLowerCase();

  switch (type) {
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 1;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      break;
  }

  if (format === 'email' || lowerName.includes('email')) return 'agentgrade-synthetic@example.com';
  if (format === 'uri' || format === 'url' || lowerName.includes('url')) return 'https://example.com/';
  if (format === 'date') return '2026-01-01';
  if (format === 'date-time') return '2026-01-01T00:00:00Z';
  if (lowerName.includes('postal') || lowerName.includes('zip')) return '10001';
  if (lowerName.includes('query') || lowerName.includes('search') || lowerName.includes('keyword')) {
    return goal.slice(0, 60) || 'agentgrade synthetic query';
  }
  if (lowerName.includes('password')) return 'AgentGrade-Synthetic-1';
  if (lowerName.includes('sku') || lowerName.includes('id') || lowerName.includes('code')) return 'AGENTGRADE-TEST-1';
  if (lowerName.includes('token')) return 'synthetic-token';
  return 'agentgrade-synthetic';
}

function inferTypeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('count') || lower.includes('limit') || lower.includes('quantity')) return 'integer';
  return 'string';
}

/** True when `args` supplies every parameter the schema marks required. */
export function satisfiesSchema(tool: RegisteredTool, args: Record<string, JsonValue>): boolean {
  if (!tool.inputSchema.isStructured) {
    // Nothing was declared, so nothing can be violated — but nothing is
    // guaranteed either. Treat an empty schema as unsatisfiable guidance.
    return Object.keys(args).length > 0;
  }
  return tool.inputSchema.required.every(
    (name) => Object.prototype.hasOwnProperty.call(args, name) && args[name] !== undefined,
  );
}

/* -------------------------------------------------------------------------- */
/* Live drivers                                                                */
/* -------------------------------------------------------------------------- */

/** True when the process carries credentials the live drivers can use. */
export function hasAnthropicCredentials(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** Imports an optional peer dependency, returning `null` when unavailable. */
async function optionalImport(specifier: string): Promise<Record<string, unknown> | null> {
  try {
    return (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Resolves the driver to use: caller-supplied, then Vercel AI SDK, then the
 * Anthropic SDK, then the deterministic simulator.
 */
async function resolveDriver(
  options: SyntheticEvaluationOptions,
): Promise<{ driver: SyntheticAgentDriver; driverWarnings: string[] }> {
  const driverWarnings: string[] = [];
  if (options.driver) return { driver: options.driver, driverWarnings };

  if (options.useLiveDriver === false) {
    return { driver: new SimulatedDriver(), driverWarnings };
  }

  if (!hasAnthropicCredentials()) {
    driverWarnings.push(
      'No ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in the environment; used the deterministic simulated driver.',
    );
    return { driver: new SimulatedDriver(), driverWarnings };
  }

  const model = options.model ?? DEFAULT_SYNTHETIC_MODEL;

  const vercel = await createVercelAiDriver(model);
  if (vercel) return { driver: vercel, driverWarnings };

  const anthropic = await createAnthropicDriver(model);
  if (anthropic) return { driver: anthropic, driverWarnings };

  driverWarnings.push(
    'Neither `ai` + `@ai-sdk/anthropic` nor `@anthropic-ai/sdk` could be resolved; used the deterministic simulated driver.',
  );
  return { driver: new SimulatedDriver(), driverWarnings };
}

/**
 * Builds a driver on the Vercel AI SDK, when `ai` and `@ai-sdk/anthropic` are
 * installed.
 *
 * The AI SDK renamed the tool-schema field (`parameters` → `inputSchema`) and
 * the call payload (`args` → `input`) across major versions, so this adapter
 * writes both and reads either. Any shape mismatch throws, which the evaluator
 * catches and downgrades to the simulated driver rather than failing the audit.
 */
export async function createVercelAiDriver(model: string): Promise<SyntheticAgentDriver | null> {
  const ai = await optionalImport('ai');
  const provider = await optionalImport('@ai-sdk/anthropic');
  if (!ai || !provider) return null;

  const generateText = ai.generateText as
    | ((options: Record<string, unknown>) => Promise<Record<string, unknown>>)
    | undefined;
  const jsonSchema = ai.jsonSchema as ((schema: unknown) => unknown) | undefined;
  const anthropic = provider.anthropic as ((id: string) => unknown) | undefined;
  if (!generateText || !anthropic) return null;

  return {
    kind: 'vercel-ai-sdk',
    async selectTool(request: ToolSelectionRequest): Promise<ToolSelection> {
      const tools: Record<string, unknown> = {};
      for (const tool of request.tools) {
        const schema = (tool.inputSchema.raw ?? { type: 'object', properties: {} }) as unknown;
        const wrapped = jsonSchema ? jsonSchema(schema) : schema;
        tools[safeToolName(tool.name)] = {
          description: tool.description ?? `Registered WebMCP tool "${tool.name}".`,
          // Written twice for cross-version tolerance; see the doc comment.
          inputSchema: wrapped,
          parameters: wrapped,
        };
      }

      const response = await generateText({
        model: anthropic(model),
        tools,
        toolChoice: 'auto',
        maxOutputTokens: 2048,
        system: SELECTION_SYSTEM_PROMPT,
        prompt: buildSelectionPrompt(request),
      });

      const calls = (response.toolCalls ?? []) as Array<Record<string, unknown>>;
      const first = calls[0];
      if (!first) {
        return {
          toolName: null,
          arguments: {},
          reasoning: typeof response.text === 'string' && response.text ? response.text : 'The model selected no tool.',
        };
      }

      const rawName = String(first.toolName ?? '');
      const matched = request.tools.find((tool) => safeToolName(tool.name) === rawName) ?? null;
      const args = (first.input ?? first.args ?? {}) as Record<string, JsonValue>;
      return {
        toolName: matched?.name ?? null,
        arguments: args,
        reasoning:
          (typeof response.text === 'string' && response.text) ||
          `The model selected "${rawName}" for the goal "${request.goal}".`,
      };
    },
  };
}

/**
 * Builds a driver on the official Anthropic SDK, when `@anthropic-ai/sdk` is
 * installed. Uses Claude Opus 5 with adaptive thinking and standard tool use.
 */
export async function createAnthropicDriver(model: string): Promise<SyntheticAgentDriver | null> {
  const sdk = await optionalImport('@anthropic-ai/sdk');
  if (!sdk) return null;
  const Anthropic = (sdk.default ?? sdk.Anthropic) as (new () => Record<string, any>) | undefined;
  if (typeof Anthropic !== 'function') return null;

  const client = new Anthropic();

  return {
    kind: 'anthropic-sdk',
    async selectTool(request: ToolSelectionRequest): Promise<ToolSelection> {
      const response = await client.messages.create({
        model,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        system: SELECTION_SYSTEM_PROMPT,
        tools: request.tools.map((tool) => ({
          name: safeToolName(tool.name),
          description: tool.description ?? `Registered WebMCP tool "${tool.name}".`,
          input_schema: normaliseSchemaForApi(tool),
        })),
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content: buildSelectionPrompt(request) }],
      });

      const blocks = (response.content ?? []) as Array<Record<string, unknown>>;
      const toolUse = blocks.find((block) => block.type === 'tool_use');
      const text = blocks
        .filter((block) => block.type === 'text')
        .map((block) => String(block.text ?? ''))
        .join(' ')
        .trim();

      if (!toolUse) {
        return { toolName: null, arguments: {}, reasoning: text || 'The model selected no tool.' };
      }

      const rawName = String(toolUse.name ?? '');
      const matched = request.tools.find((tool) => safeToolName(tool.name) === rawName) ?? null;
      return {
        toolName: matched?.name ?? null,
        arguments: (toolUse.input ?? {}) as Record<string, JsonValue>,
        reasoning: text || `The model selected "${rawName}" for the goal "${request.goal}".`,
      };
    },
  };
}

/** The API requires tool names to match `^[a-zA-Z0-9_-]{1,128}$`. */
function safeToolName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 128);
  return cleaned.length > 0 ? cleaned : 'unnamed_tool';
}

/** Coerces a scanned schema into something the Messages API will accept. */
function normaliseSchemaForApi(tool: RegisteredTool): Record<string, unknown> {
  const raw = tool.inputSchema.raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as Record<string, JsonValue>).type === 'object') {
    return raw as Record<string, unknown>;
  }
  return { type: 'object', properties: {} };
}

const SELECTION_SYSTEM_PROMPT =
  'You are auditing a website for AI-agent readiness. Given a goal and the tools the page registers via WebMCP, ' +
  'call the single tool that best accomplishes the goal, using realistic but clearly synthetic argument values. ' +
  'If no registered tool can accomplish the goal, do not call anything — explain in one sentence which capability is missing.';

function buildSelectionPrompt(request: ToolSelectionRequest): string {
  return [
    `Goal: ${request.goal}`,
    '',
    'Page summary:',
    request.pageSummary,
    '',
    `Choose the one registered tool that accomplishes this goal, or explain what is missing.`,
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* DOM fallback plan                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Builds the step-by-step DOM plan an agent is forced into when no tool covers
 * the goal, annotating each step with the traps that would break it.
 */
export function buildDomPlan(data: AgentAuditRawData, goal: BenchmarkGoal): DomPlanStep[] {
  const target = pickTargetForm(data, goal);
  const steps: DomPlanStep[] = [];
  const trapsBySelector = new Map<string, string[]>();
  for (const trap of data.frictionTraps) {
    const bucket = trapsBySelector.get(trap.selector) ?? [];
    bucket.push(trap.id);
    trapsBySelector.set(trap.selector, bucket);
  }
  const riskOf = (selector: string | null): { ids: string[]; risk: number } => {
    if (!selector) return { ids: [], risk: 0.02 };
    const ids = trapsBySelector.get(selector) ?? [];
    const traps = data.frictionTraps.filter((trap) => ids.includes(trap.id));
    let survival = 0.98;
    for (const trap of traps) {
      survival *= trap.severity === 'critical' ? 0.65 : trap.severity === 'high' ? 0.82 : trap.severity === 'medium' ? 0.93 : 0.98;
    }
    return { ids, risk: round(1 - survival, 3) };
  };

  const push = (
    action: DomPlanStep['action'],
    selector: string | null,
    intent: string,
  ): void => {
    const { ids, risk } = riskOf(selector);
    steps.push({ order: steps.length + 1, action, selector, intent, blockedByTrapIds: ids, riskScore: risk });
  };

  push('read', null, `Serialize the page (${data.page.domNodeCount} DOM nodes) into the model context.`);

  if (!target) {
    push('locate', null, `Search the page for a surface that could accomplish the "${goal}" goal.`);
    push(
      'read',
      null,
      'No matching surface was catalogued, so the agent must explore navigation links and re-read each page.',
    );
    return steps;
  }

  push('locate', target.selector, `Locate the ${target.category} surface.`);

  for (const field of target.fields.slice(0, 8)) {
    const label = field.accessibleName ?? field.name ?? field.type;
    push('focus', field.selector, `Focus the "${label}" field.`);
    push(
      'fill',
      field.selector,
      field.accessibleName
        ? `Fill "${field.accessibleName}"${field.required ? ' (required)' : ''}.`
        : `Guess what value the unlabelled ${field.type} field expects${field.required ? ' (required)' : ''}.`,
    );
  }

  const submit = target.submitControls[0];
  push(
    'click',
    submit?.selector ?? target.selector,
    submit?.accessibleName
      ? `Click "${submit.accessibleName}" to submit.`
      : 'Click the submit control, which exposes no accessible name.',
  );
  push('wait', null, 'Wait for navigation or a re-render, then re-serialize the page to confirm the outcome.');
  push('read', null, 'Verify the transaction completed by re-reading the page.');

  return steps;
}

/** Chooses the form the goal would have to be executed against. */
function pickTargetForm(data: AgentAuditRawData, goal: BenchmarkGoal): DiscoveredForm | null {
  const byCategory = data.forms.filter((form) => form.category === goal);
  if (byCategory.length > 0) return byCategory[0];
  const critical = data.forms.filter((form) =>
    ['checkout', 'authentication', 'signup', 'search'].includes(form.category),
  );
  if (critical.length > 0) return critical[0];
  return data.forms[0] ?? null;
}

/** One-line risk characterisation of a plan, for the reasoning string. */
function describePlanRisk(plan: DomPlanStep[]): string {
  const blocked = plan.filter((step) => step.blockedByTrapIds.length > 0);
  if (blocked.length === 0) return 'no step is blocked by a detected friction trap';
  const worst = blocked.reduce((best, step) => (step.riskScore > best.riskScore ? step : best));
  return `${blocked.length} step(s) sit on a detected friction trap, the worst at ${round(worst.riskScore * 100, 1)}% first-attempt failure risk`;
}

/* -------------------------------------------------------------------------- */
/* Page summary                                                                */
/* -------------------------------------------------------------------------- */

/** Compact page description handed to a live driver as context. */
export function summarisePage(data: AgentAuditRawData): string {
  const lines: string[] = [
    `URL: ${data.navigation.finalUrl ?? data.target.requestedUrl}`,
    `Title: ${data.page.title ?? '(none)'}`,
    `Registered tools: ${data.tools.length} (${data.tools.filter((tool) => tool.executable).length} executable)`,
  ];

  if (data.forms.length > 0) {
    lines.push('Interactive surfaces:');
    for (const form of data.forms.slice(0, 12)) {
      lines.push(`  - ${form.category} at ${form.selector} (${form.fields.length} field(s))`);
    }
  }

  if (data.frictionTraps.length > 0) {
    const counts = new Map<string, number>();
    for (const trap of data.frictionTraps) counts.set(trap.type, (counts.get(trap.type) ?? 0) + 1);
    lines.push(
      `Friction traps: ${Array.from(counts.entries())
        .map(([type, count]) => `${type}×${count}`)
        .join(', ')}`,
    );
  }

  return lines.join('\n');
}

/** Classification helper re-exported for callers building their own drivers. */
export function toolKind(tool: RegisteredTool): ToolKind {
  return classifyTool(tool);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] : String(error);
}
