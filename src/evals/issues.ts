/**
 * AgentGrade — issue synthesizer.
 *
 * Turns scoring deductions and scanner diagnostics into {@link AuditIssue}
 * records a developer can work through top-down.
 *
 * The central invariant: **issue deductions reconcile against the score.**
 * Every point a pillar lost is attributed to exactly one issue, so
 * `sum(issue.deductionPoints) === 100 - overallScoreExact`. A scorecard can
 * therefore never claim a deduction it cannot explain, or explain one it did
 * not take.
 */

import type { AgentAuditRawData, FrictionTrap, JsonValue } from '../scanner/types.js';
import {
  TRAP_SEVERITY_WEIGHT,
  CRITICAL_CATEGORIES,
  CRITICAL_SURFACE_TRAP_MULTIPLIER,
  groupTrapsByType,
  round,
  type SurfaceCoverage,
} from './analysis.js';
import {
  PILLAR_WEIGHTS,
  type AuditIssue,
  type IssueSeverity,
  type PillarId,
  type PillarScore,
  type ScoreComponent,
} from './types.js';

/** Losses below this many pillar points are noise, not findings. */
const MIN_REPORTABLE_LOSS = 0.01;

/** Ranking order for ties on deduction points. */
const SEVERITY_RANK: Record<IssueSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** Input required to synthesize issues for a scored audit. */
export interface IssueSynthesisInput {
  data: AgentAuditRawData;
  coverage: SurfaceCoverage[];
  pillars: PillarScore[];
  overallScoreExact: number;
}

/**
 * A pending issue, expressed in *pillar* points (0–100 within its pillar).
 * `share` is converted to overall points by {@link synthesizeIssues}.
 */
interface IssueDraft {
  id: string;
  title: string;
  severity: IssueSeverity;
  pillar: PillarId;
  impactDescription: string;
  remediation: string;
  evidence: Record<string, JsonValue>;
  relatedSelectors: string[];
  componentId: string | null;
  /** Points lost within the pillar's 100 that this issue accounts for. */
  share: number;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Builds the ranked issue list for a scored audit.
 *
 * Ordering is deterministic: highest deduction first, then severity, then id.
 */
export function synthesizeIssues(input: IssueSynthesisInput): AuditIssue[] {
  const byPillar = new Map(input.pillars.map((pillar) => [pillar.pillar, pillar]));
  const drafts: IssueDraft[] = [
    ...draftDiscoveryIssues(input, componentsOf(byPillar, 'discovery')),
    ...draftActionabilityIssues(input, componentsOf(byPillar, 'actionability')),
    ...draftFrictionIssues(input, componentsOf(byPillar, 'friction')),
    ...draftSafetyIssues(input, componentsOf(byPillar, 'safety')),
  ];

  const issues: AuditIssue[] = drafts.map((draft) => ({
    id: draft.id,
    title: draft.title,
    severity: draft.severity,
    pillar: draft.pillar,
    impactDescription: draft.impactDescription,
    deductionPoints: round(draft.share * PILLAR_WEIGHTS[draft.pillar] * pillarScale(byPillar, draft.pillar), 4),
    remediation: draft.remediation,
    evidence: draft.evidence,
    relatedSelectors: draft.relatedSelectors,
    componentId: draft.componentId,
  }));

  // Scanner diagnostics describe the *scan*, not the site, so they carry no
  // deduction — but a developer still needs to see that a stage degraded.
  issues.push(...diagnosticIssues(input.data));

  reconcile(issues, round(100 - input.overallScoreExact, 4));

  return issues.sort(
    (a, b) =>
      b.deductionPoints - a.deductionPoints ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.id.localeCompare(b.id),
  );
}

/* -------------------------------------------------------------------------- */
/* Reconciliation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Pillar components are authored to total 100 possible points. This rescales
 * defensively so a future budget change cannot silently break reconciliation.
 */
function pillarScale(byPillar: Map<PillarId, PillarScore>, pillar: PillarId): number {
  const possible = (byPillar.get(pillar)?.components ?? []).reduce(
    (total, component) => total + component.possible,
    0,
  );
  return possible === 0 ? 0 : 100 / possible;
}

function componentsOf(byPillar: Map<PillarId, PillarScore>, pillar: PillarId): Map<string, ScoreComponent> {
  return new Map((byPillar.get(pillar)?.components ?? []).map((component) => [component.id, component]));
}

/** Points a component failed to earn. */
function lossOf(components: Map<string, ScoreComponent>, id: string): number {
  const component = components.get(id);
  if (!component) return 0;
  return Math.max(0, round(component.possible - component.earned, 6));
}

/**
 * Absorbs float drift so the deductions sum exactly to the points lost.
 * The residual lands on the largest deduction, where it is proportionally
 * least significant.
 */
function reconcile(issues: AuditIssue[], targetTotal: number): void {
  const deducting = issues.filter((issue) => issue.deductionPoints > 0);
  if (deducting.length === 0) return;
  const total = deducting.reduce((sum, issue) => sum + issue.deductionPoints, 0);
  const residual = round(targetTotal - total, 4);
  if (Math.abs(residual) < 1e-9) return;
  const largest = deducting.reduce((best, issue) => (issue.deductionPoints > best.deductionPoints ? issue : best));
  largest.deductionPoints = round(Math.max(0, largest.deductionPoints + residual), 4);
}

/* -------------------------------------------------------------------------- */
/* Discovery issues                                                            */
/* -------------------------------------------------------------------------- */

function draftDiscoveryIssues(
  input: IssueSynthesisInput,
  components: Map<string, ScoreComponent>,
): IssueDraft[] {
  const drafts: IssueDraft[] = [];
  const { data } = input;

  const push = (
    componentId: string,
    id: string,
    title: string,
    severity: IssueSeverity,
    impact: string,
    remediation: string,
    evidence: Record<string, JsonValue> = {},
  ): void => {
    const share = lossOf(components, componentId);
    if (share < MIN_REPORTABLE_LOSS) return;
    drafts.push({
      id,
      title,
      severity,
      pillar: 'discovery',
      impactDescription: impact,
      remediation,
      evidence: { ...(components.get(componentId)?.evidence ?? {}), ...evidence },
      relatedSelectors: [],
      componentId,
      share,
    });
  };

  push(
    'llms-txt',
    'discovery.missing-llms-txt',
    'Publish /llms.txt',
    'info',
    'Agents that crawl before they render have no prose summary of what this site does, so they must load and read the page to find out.',
    'Serve a /llms.txt listing the site’s key capabilities and the URLs behind them, as markdown links with one-line descriptions.',
  );

  push(
    'well-known-mcp',
    'discovery.missing-well-known-mcp',
    'Publish a /.well-known/mcp tool manifest',
    'warning',
    'Tools cannot be discovered without executing the page, so any agent that does not run JavaScript sees no callable surface at all.',
    'Serve /.well-known/mcp as JSON with a `tools` array, each entry carrying `name`, `description`, and a JSON Schema `inputSchema`.',
  );

  push(
    'well-known-agent',
    'discovery.missing-agent-card',
    'Publish a /.well-known/agent.json card',
    'info',
    'An agent cannot learn this service’s identity, skills, or contact surface declaratively, so it has to infer them from page content.',
    'Serve /.well-known/agent.json with `name`, `description`, `url`, and a `skills` array describing what the service can do.',
  );

  push(
    'semantic-metadata',
    'discovery.weak-semantic-metadata',
    'Strengthen semantic page metadata',
    'info',
    'Missing landmarks, headings, or descriptions force an agent to guess at page structure, which makes every subsequent DOM read less reliable.',
    'Add the missing signals: a `<title>`, a `meta[name="description"]`, `lang` on `<html>`, exactly one `<main>`, an `<h1>`, and a `<link rel="mcp-manifest">`.',
  );

  const hasTools = data.tools.length > 0;
  push(
    'tool-description-clarity',
    hasTools ? 'discovery.unclear-tool-descriptions' : 'discovery.no-registered-tools',
    hasTools ? 'Write descriptions that explain what each tool does' : 'Register WebMCP tools',
    hasTools ? 'warning' : 'critical',
    hasTools
      ? 'A tool whose description restates its name gives the model nothing to select on, so it will pick the wrong tool or fall back to the DOM.'
      : 'No tools are registered anywhere, so an agent has nothing to call and must drive the DOM for every task.',
    hasTools
      ? 'Describe the action and its effect in a sentence — what it does, what it returns, and when to use it rather than a sibling tool.'
      : 'Register tools with `navigator.modelContext.registerTool()` for the actions this page exists to perform.',
  );

  return drafts;
}

/* -------------------------------------------------------------------------- */
/* Actionability issues                                                        */
/* -------------------------------------------------------------------------- */

function draftActionabilityIssues(
  input: IssueSynthesisInput,
  components: Map<string, ScoreComponent>,
): IssueDraft[] {
  const drafts: IssueDraft[] = [];
  const { data, coverage } = input;

  // Degenerate case: the page has no critical surface, so the pillar collapsed
  // to a single tool-surface component.
  const fallbackLoss = lossOf(components, 'tool-surface-only');
  if (fallbackLoss >= MIN_REPORTABLE_LOSS) {
    const hasTools = data.tools.length > 0;
    drafts.push({
      id: hasTools ? 'actionability.tools-not-executable' : 'actionability.no-agent-surface',
      title: hasTools ? 'Make declared tools callable at runtime' : 'Expose an agent-actionable surface',
      severity: 'critical',
      pillar: 'actionability',
      impactDescription: hasTools
        ? 'Tools are declared but none expose a callable handler, so an agent can read the contract and still not execute it.'
        : 'This page offers neither a critical interactive surface nor a registered tool, so there is no supported way for an agent to act on it.',
      remediation: hasTools
        ? 'Register the declared tools at runtime with an `execute` handler via `navigator.modelContext.registerTool()`.'
        : 'Expose the page’s primary action either as a labelled, semantic form or as a registered WebMCP tool.',
      evidence: components.get('tool-surface-only')?.evidence ?? {},
      relatedSelectors: [],
      componentId: 'tool-surface-only',
      share: fallbackLoss,
    });
    return drafts;
  }

  // The uncovered critical surfaces jointly account for the coverage loss and
  // the DOM-only-exposure loss; splitting evenly keeps one issue per surface.
  const uncovered = coverage.filter((entry) => entry.critical && entry.domOnly);
  const surfaceLoss = lossOf(components, 'critical-surface-coverage') + lossOf(components, 'dom-only-exposure');
  if (uncovered.length > 0 && surfaceLoss >= MIN_REPORTABLE_LOSS) {
    const perSurface = surfaceLoss / uncovered.length;
    for (const entry of uncovered) {
      drafts.push({
        id: `actionability.uncovered-${entry.form.category}-${entry.form.id}`,
        title: `Back the ${entry.form.category} surface with a WebMCP tool`,
        severity: entry.form.category === 'checkout' ? 'critical' : 'warning',
        pillar: 'actionability',
        impactDescription: `The ${entry.form.category} surface at \`${entry.form.selector}\` can only be operated by driving raw DOM: an agent must locate ${entry.form.fields.length} field(s), fill each one, and click through, with every friction trap on the page in its path.`,
        remediation: `Register a tool for this action (for example \`${suggestToolName(entry.form.category)}\`) with a typed input schema covering ${describeFields(entry)}, and annotate the form with \`data-mcp-tool\`.`,
        evidence: {
          formId: entry.form.id,
          category: entry.form.category,
          fieldCount: entry.form.fields.length,
          fieldNames: entry.form.fields.map((field) => field.name || field.id || field.type).slice(0, 20),
          isNativeForm: entry.form.isNativeForm,
          trapIds: entry.form.trapIds,
        },
        relatedSelectors: [entry.form.selector],
        componentId: 'critical-surface-coverage',
        share: perSurface,
      });
    }
  }

  const overallLoss = lossOf(components, 'overall-surface-coverage');
  if (overallLoss >= MIN_REPORTABLE_LOSS) {
    const uncoveredAll = coverage.filter((entry) => entry.domOnly);
    drafts.push({
      id: 'actionability.partial-surface-coverage',
      title: 'Extend tool coverage to secondary surfaces',
      severity: 'info',
      pillar: 'actionability',
      impactDescription: `${uncoveredAll.length} of ${coverage.length} interactive surface(s) have no registered tool, so agent journeys that touch them drop back to DOM traversal partway through.`,
      remediation: 'Register tools for the remaining surfaces, starting with the ones users reach most often.',
      evidence: {
        surfaceCount: coverage.length,
        uncoveredCount: uncoveredAll.length,
        categories: Array.from(new Set(uncoveredAll.map((entry) => entry.form.category))),
      },
      relatedSelectors: uncoveredAll.map((entry) => entry.form.selector).slice(0, 20),
      componentId: 'overall-surface-coverage',
      share: overallLoss,
    });
  }

  const executableLoss = lossOf(components, 'executable-tools');
  if (executableLoss >= MIN_REPORTABLE_LOSS) {
    const executableCount = data.tools.filter((tool) => tool.executable).length;
    drafts.push({
      id: 'actionability.insufficient-executable-tools',
      title:
        executableCount === 0
          ? 'Register at least one callable tool at runtime'
          : 'Register callable tools for every critical surface',
      severity: executableCount === 0 ? 'critical' : 'warning',
      pillar: 'actionability',
      impactDescription:
        executableCount === 0
          ? 'Every tool on this page is declarative only — nothing exposes an `execute` handler, so an agent that resolves a tool still cannot invoke it.'
          : `${executableCount} executable tool(s) cover ${coverage.filter((entry) => entry.critical).length} critical surface(s), leaving some journeys without a callable path.`,
      remediation:
        'Call `navigator.modelContext.registerTool({ name, description, inputSchema, execute })` for each critical action so the tool is callable, not just declared.',
      evidence: components.get('executable-tools')?.evidence ?? {},
      relatedSelectors: [],
      componentId: 'executable-tools',
      share: executableLoss,
    });
  }

  return drafts;
}

/** Suggests an idiomatic tool name for an uncovered surface category. */
function suggestToolName(category: string): string {
  switch (category) {
    case 'search':
      return 'search_products';
    case 'checkout':
      return 'place_order';
    case 'authentication':
      return 'sign_in';
    case 'signup':
      return 'create_account';
    default:
      return `submit_${category.replace(/[^a-z0-9]+/gi, '_')}`;
  }
}

/** Describes a surface's fields for the remediation copy. */
function describeFields(entry: SurfaceCoverage): string {
  const names = entry.form.fields
    .map((field) => field.name || field.id)
    .filter((name) => name.length > 0)
    .slice(0, 5);
  return names.length > 0 ? names.map((name) => `\`${name}\``).join(', ') : 'the fields this surface submits';
}

/* -------------------------------------------------------------------------- */
/* Friction issues                                                             */
/* -------------------------------------------------------------------------- */

/** Copy for each trap type: what it costs an agent, and how to remove it. */
const TRAP_COPY: Record<
  FrictionTrap['type'],
  { title: string; impact: string; remediation: string }
> = {
  'unlabelled-control': {
    title: 'Give every control an accessible name',
    impact:
      'An agent addresses controls by intent ("click the cart button"). An unnamed control is invisible to that lookup, so the agent either clicks the wrong thing or stalls.',
    remediation: 'Add visible text or `aria-label` describing the action each control performs.',
  },
  'unlabelled-input': {
    title: 'Label every input programmatically',
    impact:
      'Without a programmatic label an agent cannot tell which value belongs in which field, so it fills the form wrongly or abandons it.',
    remediation: 'Associate a `<label for>` with each field, or set `aria-label`; a placeholder is not a label.',
  },
  'opaque-iframe': {
    title: 'Title every iframe and expose its action on the host page',
    impact:
      'An untitled or lazily-injected frame is an opaque box mid-transaction — most often the payment step, exactly where failure costs the most.',
    remediation:
      'Give each iframe a descriptive `title`, and expose the embedded action as a labelled host-page control or a WebMCP tool.',
  },
  'nested-scroll-container': {
    title: 'Flatten nested scroll containers',
    impact:
      'Content inside a nested scroll region is absent from a single-pass DOM read, so an agent believes the list is shorter than it is and picks from the wrong subset.',
    remediation:
      'Flatten the scroll hierarchy, paginate with real links, or expose the full collection through a tool that returns the items directly.',
  },
  'non-semantic-control': {
    title: 'Use semantic elements for clickable things',
    impact:
      'A `div` that behaves like a button is not recognised as actionable, so the agent never considers it a candidate for the action it needs.',
    remediation: 'Use `<button>`/`<a href>`, or add `role="button"`, `tabindex="0"`, and keyboard handlers.',
  },
  'multi-step-non-semantic': {
    title: 'Make multi-step flows navigable',
    impact:
      'An agent cannot tell which step it is on or how to advance, so a multi-step checkout becomes unfinishable — the single most expensive failure on the page.',
    remediation:
      'Render step controls as `<button>`s, mark the active step with `aria-current="step"`, and expose the whole flow as one tool call.',
  },
  'closed-shadow-surface': {
    title: 'Open shadow roots or mirror their state',
    impact:
      'A closed shadow root renders pixels an agent cannot read, so whatever it contains is functionally missing from the page.',
    remediation: 'Attach shadow roots in `open` mode and mirror key state onto ARIA attributes.',
  },
  'pointer-only-interaction': {
    title: 'Provide keyboard equivalents for pointer gestures',
    impact:
      'Drag and hover interactions have no reliable programmatic equivalent, so any journey that requires one is closed to agents.',
    remediation: 'Add an equivalent button or keyboard affordance alongside the pointer gesture.',
  },
};

function draftFrictionIssues(
  input: IssueSynthesisInput,
  components: Map<string, ScoreComponent>,
): IssueDraft[] {
  const totalLoss = lossOf(components, 'trap-penalty');
  if (totalLoss < MIN_REPORTABLE_LOSS) return [];

  const criticalFormIds = new Set(
    input.data.forms.filter((form) => CRITICAL_CATEGORIES.has(form.category)).map((form) => form.id),
  );
  const penaltyOf = (trap: FrictionTrap): number =>
    (TRAP_SEVERITY_WEIGHT[trap.severity] ?? 0) *
    (trap.formId && criticalFormIds.has(trap.formId) ? CRITICAL_SURFACE_TRAP_MULTIPLIER : 1);

  const grouped = groupTrapsByType(input.data.frictionTraps);
  const totalPenalty = input.data.frictionTraps.reduce((sum, trap) => sum + penaltyOf(trap), 0);
  if (totalPenalty <= 0) return [];

  const drafts: IssueDraft[] = [];
  for (const [type, traps] of grouped) {
    const groupPenalty = traps.reduce((sum, trap) => sum + penaltyOf(trap), 0);
    // The pillar clamps at 100, so distribute the *capped* loss proportionally.
    const share = totalLoss * (groupPenalty / totalPenalty);
    if (share < MIN_REPORTABLE_LOSS) continue;

    const worst = traps.reduce((best, trap) =>
      TRAP_SEVERITY_WEIGHT[trap.severity] > TRAP_SEVERITY_WEIGHT[best.severity] ? trap : best,
    );
    const copy = TRAP_COPY[type];
    const inCritical = traps.filter((trap) => trap.formId && criticalFormIds.has(trap.formId));

    drafts.push({
      id: `friction.${type}`,
      title: copy.title,
      severity: severityForTrapGroup(worst.severity, inCritical.length > 0),
      pillar: 'friction',
      impactDescription:
        `${traps.length} × ${type}${inCritical.length > 0 ? ` (${inCritical.length} inside a critical surface)` : ''}. ` +
        copy.impact,
      remediation: copy.remediation,
      evidence: {
        type,
        count: traps.length,
        worstSeverity: worst.severity,
        insideCriticalSurface: inCritical.length,
        weightedPenalty: round(groupPenalty, 2),
        examples: traps.slice(0, 5).map((trap) => trap.message),
      },
      relatedSelectors: traps.map((trap) => trap.selector).slice(0, 20),
      componentId: 'trap-penalty',
      share,
    });
  }

  return drafts;
}

/** A trap group inside a critical surface is escalated one level. */
function severityForTrapGroup(worst: FrictionTrap['severity'], insideCritical: boolean): IssueSeverity {
  if (worst === 'critical') return 'critical';
  if (worst === 'high') return insideCritical ? 'critical' : 'warning';
  if (worst === 'medium') return insideCritical ? 'warning' : 'info';
  return 'info';
}

/* -------------------------------------------------------------------------- */
/* Safety issues                                                               */
/* -------------------------------------------------------------------------- */

function draftSafetyIssues(
  input: IssueSynthesisInput,
  components: Map<string, ScoreComponent>,
): IssueDraft[] {
  const drafts: IssueDraft[] = [];

  const noTools = lossOf(components, 'no-tools-to-assess');
  if (noTools >= MIN_REPORTABLE_LOSS) {
    drafts.push({
      id: 'safety.no-tools-to-assess',
      title: 'Register tools with typed, annotated schemas',
      severity: 'warning',
      pillar: 'safety',
      impactDescription:
        'With no tools registered there is no schema for an agent to validate against and no read/write annotation to reason about, so every action is an unguarded guess against the DOM.',
      remediation:
        'Register each action as a tool with a JSON Schema `inputSchema`, per-parameter descriptions, and an `annotations.readOnlyHint` that states whether it mutates state.',
      evidence: { toolCount: 0 },
      relatedSelectors: [],
      componentId: 'no-tools-to-assess',
      share: noTools,
    });
    return drafts;
  }

  const add = (
    componentId: string,
    id: string,
    title: string,
    severity: IssueSeverity,
    impact: string,
    remediation: string,
  ): void => {
    const share = lossOf(components, componentId);
    if (share < MIN_REPORTABLE_LOSS) return;
    drafts.push({
      id,
      title,
      severity,
      pillar: 'safety',
      impactDescription: impact,
      remediation,
      evidence: components.get(componentId)?.evidence ?? {},
      relatedSelectors: [],
      componentId,
      share,
    });
  };

  add(
    'structured-schemas',
    'safety.missing-input-schemas',
    'Give every tool a typed input schema',
    'warning',
    'A tool without a declared schema forces the model to invent an argument shape, which fails validation at the boundary or, worse, succeeds with the wrong values.',
    'Declare `inputSchema` as a JSON Schema object with `type`, `properties`, and `required`.',
  );

  add(
    'parameter-descriptions',
    'safety.undocumented-parameters',
    'Describe every tool parameter',
    'info',
    'An undescribed parameter is guessed from its name alone. `limit`, `id`, and `code` all mean several things, and the model picks the wrong one.',
    'Add a `description` to each entry in `inputSchema.properties` saying what the value is and what format it takes.',
  );

  add(
    'required-parameters',
    'safety.undeclared-required-parameters',
    'Declare which parameters are required',
    'info',
    'Without a `required` list the model cannot tell mandatory arguments from optional ones, so it omits values the handler depends on.',
    'List every mandatory parameter in the schema’s `required` array.',
  );

  // The readOnlyHint budget splits into a mislabelling issue and an omission
  // issue, weighted by how much of the loss each is responsible for.
  const annotationLoss = lossOf(components, 'read-only-hints');
  if (annotationLoss >= MIN_REPORTABLE_LOSS) {
    const evidence = components.get('read-only-hints')?.evidence ?? {};
    const mislabelled = Array.isArray(evidence.mislabelled) ? (evidence.mislabelled as string[]) : [];
    const unannotatedMutations = Array.isArray(evidence.unannotatedMutations)
      ? (evidence.unannotatedMutations as string[])
      : [];

    // Mislabelled tools cost a full point each, unannotated mutations likewise;
    // anything left over is the low-stakes unannotated-query remainder.
    const weights = [
      { key: 'mislabelled', count: mislabelled.length },
      { key: 'unannotated-mutations', count: unannotatedMutations.length },
    ];
    const namedCount = weights.reduce((total, entry) => total + entry.count, 0);

    if (mislabelled.length > 0) {
      const share = annotationLoss * (mislabelled.length / Math.max(1, namedCount));
      drafts.push({
        id: 'safety.mislabelled-read-only-tools',
        title: 'Fix tools annotated read-only that mutate state',
        severity: 'critical',
        pillar: 'safety',
        impactDescription: `${mislabelled.join(', ')} claim(s) \`readOnlyHint: true\` while naming a mutating action. An agent will treat these as safe to call speculatively — spending money, sending mail, or placing orders without confirmation.`,
        remediation:
          'Set `annotations.readOnlyHint: false` on any tool that changes state, and add `destructiveHint: true` where the change is not easily undone.',
        evidence: { mislabelled: mislabelled as unknown as JsonValue },
        relatedSelectors: [],
        componentId: 'read-only-hints',
        share,
      });
    }

    const remaining = round(
      annotationLoss - drafts.filter((draft) => draft.componentId === 'read-only-hints').reduce((sum, draft) => sum + draft.share, 0),
      6,
    );
    if (remaining >= MIN_REPORTABLE_LOSS) {
      drafts.push({
        id: 'safety.missing-read-only-hints',
        title: 'Annotate read/write intent on every tool',
        severity: unannotatedMutations.length > 0 ? 'warning' : 'info',
        pillar: 'safety',
        impactDescription:
          unannotatedMutations.length > 0
            ? `${unannotatedMutations.join(', ')} mutate state but carry no \`readOnlyHint\`, so an agent cannot tell a lookup from a purchase before it calls.`
            : 'Tools carry no explicit `readOnlyHint`, so an agent has to infer from the name whether a call is safe to retry.',
        remediation:
          'Set `annotations.readOnlyHint` explicitly on every tool: `true` for lookups, `false` for anything that writes.',
        evidence: {
          unannotatedMutations: unannotatedMutations as unknown as JsonValue,
          annotationRatio: (evidence.annotationRatio ?? null) as JsonValue,
        },
        relatedSelectors: [],
        componentId: 'read-only-hints',
        share: remaining,
      });
    }
  }

  return drafts;
}

/* -------------------------------------------------------------------------- */
/* Scanner diagnostics                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Surfaces scan-quality problems as zero-deduction issues.
 *
 * A stage that degraded (a blocked descriptor fetch, a partial DOM pass) is not
 * the site's fault and must not move the score — but it does tell the reader
 * why a pillar may be under-reporting.
 */
function diagnosticIssues(data: AgentAuditRawData): AuditIssue[] {
  const notable = data.diagnostics.filter(
    (diagnostic) => diagnostic.level === 'error' || diagnostic.level === 'warning',
  );
  if (notable.length === 0) return [];

  const byCode = new Map<string, typeof notable>();
  for (const diagnostic of notable) {
    const bucket = byCode.get(diagnostic.code);
    if (bucket) bucket.push(diagnostic);
    else byCode.set(diagnostic.code, [diagnostic]);
  }

  return Array.from(byCode.entries()).map(([code, entries]) => ({
    id: `scan.${code}`,
    title: `Scan diagnostic: ${code}`,
    severity: (entries.some((entry) => entry.level === 'error') ? 'warning' : 'info') as IssueSeverity,
    pillar: 'discovery' as PillarId,
    impactDescription: `The ${entries[0].stage} stage reported: ${entries[0].message}${entries.length > 1 ? ` (and ${entries.length - 1} more)` : ''}. Results for that stage may be incomplete.`,
    deductionPoints: 0,
    remediation:
      'Re-run the scan with a longer timeout, or check whether the target blocks automated clients, before acting on the affected pillar.',
    evidence: {
      code,
      stage: entries[0].stage,
      occurrences: entries.length,
      messages: entries.slice(0, 5).map((entry) => entry.message),
    },
    relatedSelectors: [],
    componentId: null,
  }));
}
