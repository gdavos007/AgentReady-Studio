/**
 * Builders for synthetic {@link AgentAuditRawData} payloads.
 *
 * The evaluation layer must behave on inputs the real scanner would rarely
 * produce — zero tools with ten traps, ten tools with none, a scan that found
 * nothing at all. These factories make those shapes cheap to construct while
 * keeping every payload schema-valid, so the same `validateAgentAuditRawData`
 * that guards production also guards the fixtures.
 */

import {
  AUDIT_SCHEMA_VERSION,
  type AgentAuditRawData,
  type DescriptorProbe,
  type DiscoveredField,
  type DiscoveredForm,
  type FormCategory,
  type FrictionTrap,
  type FrictionTrapType,
  type JsonValue,
  type RegisteredTool,
  type ToolSource,
  type TrapSeverity,
} from '../../src/scanner/types.js';

let sequence = 0;
const nextId = (): number => ++sequence;

/** Resets the id counter so a test file produces stable identifiers. */
export function resetFactory(): void {
  sequence = 0;
}

/** Builds a {@link RegisteredTool} with sensible, well-formed defaults. */
export function makeTool(overrides: Partial<RegisteredTool> = {}): RegisteredTool {
  const name = overrides.name ?? `tool_${nextId()}`;
  const schemaRaw =
    overrides.inputSchema?.raw ??
    ({
      type: 'object',
      properties: { query: { type: 'string', description: 'The text to search for.' } },
      required: ['query'],
    } as JsonValue);

  return {
    id: overrides.id ?? `navigator.modelContext:${name}`,
    name,
    description: overrides.description !== undefined ? overrides.description : `Performs the ${name} action for a caller.`,
    inputSchema: overrides.inputSchema ?? {
      raw: schemaRaw,
      type: 'object',
      propertyNames: ['query'],
      required: ['query'],
      isStructured: true,
    },
    outputSchema: overrides.outputSchema ?? null,
    source: overrides.source ?? ('navigator.modelContext' as ToolSource),
    executable: overrides.executable ?? true,
    annotations: overrides.annotations ?? { readOnlyHint: true },
    selector: overrides.selector ?? null,
    manifestUrl: overrides.manifestUrl ?? null,
  };
}

/** Builds a {@link DiscoveredField}. */
export function makeField(overrides: Partial<DiscoveredField> = {}): DiscoveredField {
  const name = overrides.name ?? `field_${nextId()}`;
  return {
    tagName: overrides.tagName ?? 'input',
    type: overrides.type ?? 'text',
    name,
    id: overrides.id ?? name,
    accessibleName: overrides.accessibleName !== undefined ? overrides.accessibleName : `Label for ${name}`,
    labelSource: overrides.labelSource ?? 'label-element',
    required: overrides.required ?? false,
    autocomplete: overrides.autocomplete ?? null,
    selector: overrides.selector ?? `#${name}`,
  };
}

/** Builds a {@link DiscoveredForm}. */
export function makeForm(overrides: Partial<DiscoveredForm> = {}): DiscoveredForm {
  const id = overrides.id ?? `form-${nextId()}`;
  const category: FormCategory = overrides.category ?? 'generic';
  return {
    id,
    tagName: overrides.tagName ?? 'form',
    isNativeForm: overrides.isNativeForm ?? true,
    selector: overrides.selector ?? `form#${id}`,
    name: overrides.name !== undefined ? overrides.name : `${category} form`,
    category,
    action: overrides.action ?? null,
    method: overrides.method !== undefined ? overrides.method : 'POST',
    fields: overrides.fields ?? [makeField()],
    submitControls: overrides.submitControls ?? [
      {
        tagName: 'button',
        selector: `form#${id} button`,
        accessibleName: 'Submit',
        role: 'button',
        text: 'Submit',
        focusable: true,
        visible: true,
      },
    ],
    fullyLabelled: overrides.fullyLabelled ?? true,
    inModal: overrides.inModal ?? false,
    visible: overrides.visible ?? true,
    trapIds: overrides.trapIds ?? [],
    mcpAnnotated: overrides.mcpAnnotated ?? false,
  };
}

/** Builds a {@link FrictionTrap}. */
export function makeTrap(overrides: Partial<FrictionTrap> = {}): FrictionTrap {
  const id = overrides.id ?? `trap-${nextId()}`;
  const type: FrictionTrapType = overrides.type ?? 'unlabelled-control';
  return {
    id,
    type,
    severity: overrides.severity ?? ('medium' as TrapSeverity),
    selector: overrides.selector ?? `#${id}`,
    tagName: overrides.tagName ?? 'button',
    message: overrides.message ?? `Synthetic ${type} trap for testing.`,
    evidence: overrides.evidence ?? {},
    recommendation: overrides.recommendation ?? 'Fix the synthetic trap.',
    formId: overrides.formId !== undefined ? overrides.formId : null,
  };
}

/** Builds a {@link DescriptorProbe}. */
export function makeDescriptor(
  kind: DescriptorProbe['kind'],
  found: boolean,
  overrides: Partial<DescriptorProbe> = {},
): DescriptorProbe {
  return {
    url: overrides.url ?? `https://example.test/${kind}`,
    kind,
    found,
    status: overrides.status !== undefined ? overrides.status : found ? 200 : 404,
    contentType: overrides.contentType ?? (found ? 'application/json' : null),
    body: overrides.body ?? (found ? '{}' : null),
    json: overrides.json ?? (found ? {} : null),
    byteLength: overrides.byteLength ?? (found ? 2 : 0),
    error: overrides.error ?? (found ? null : 'Not found'),
  };
}

/** The three descriptor probes a real scan always emits. */
export function makeDescriptors(found: { mcp?: boolean; agent?: boolean; llms?: boolean } = {}): DescriptorProbe[] {
  return [
    makeDescriptor('well-known-mcp', found.mcp ?? false),
    makeDescriptor('well-known-agent', found.agent ?? false),
    makeDescriptor('llms-txt', found.llms ?? false),
  ];
}

/**
 * Builds a complete, schema-valid {@link AgentAuditRawData}.
 * Every field defaults to the "nothing found" case, so a test only states the
 * dimension it is actually exercising.
 */
export function makeAuditData(overrides: Partial<AgentAuditRawData> = {}): AgentAuditRawData {
  const tools = overrides.tools ?? [];
  const forms = overrides.forms ?? [];
  const frictionTraps = overrides.frictionTraps ?? [];
  const descriptors = overrides.declarative?.descriptors ?? makeDescriptors();

  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    scanId: overrides.scanId ?? 'synthetic-scan-0001',
    target: overrides.target ?? {
      requestedUrl: 'https://example.test/',
      origin: 'https://example.test',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
      userAgent: 'AgentGradeTest/1.0',
      viewport: { width: 1440, height: 900 },
    },
    navigation: overrides.navigation ?? {
      status: 'loaded',
      requestedUrl: 'https://example.test/',
      finalUrl: 'https://example.test/',
      httpStatus: 200,
      title: 'Example',
      durationMs: 500,
      redirectCount: 0,
      botWallDetected: false,
      botWallSignals: [],
      error: null,
    },
    page: overrides.page ?? {
      title: 'Example',
      lang: 'en',
      description: null,
      landmarkCount: 1,
      hasSingleMainLandmark: true,
      headingLevels: [1],
      domNodeCount: 240,
      shadowRootCount: 0,
      iframeCount: 0,
      requiresJavaScript: false,
    },
    runtime: overrides.runtime ?? {
      detected: tools.some((tool) => tool.source === 'navigator.modelContext'),
      settleMs: 0,
      probes: [
        {
          path: 'navigator.modelContext',
          present: tools.length > 0,
          valueType: tools.length > 0 ? 'object' : null,
          apiSurface: tools.length > 0 ? ['registerTool'] : [],
          supportsRegistration: tools.length > 0,
          tools: tools.filter((tool) => tool.source === 'navigator.modelContext'),
          error: null,
        },
        {
          path: 'document.modelContext',
          present: false,
          valueType: null,
          apiSurface: [],
          supportsRegistration: false,
          tools: [],
          error: null,
        },
      ],
      tools: tools.filter((tool) => tool.source === 'navigator.modelContext'),
    },
    declarative: overrides.declarative ?? {
      descriptors,
      tags: [],
      tools: [],
      manifestLinks: [],
    },
    tools,
    forms,
    controls: overrides.controls ?? [],
    frictionTraps,
    // Filled in by the scorer's own summary; the scanner summary is not read by
    // Phase 2, so a minimal valid object is enough.
    summary: overrides.summary ?? {
      totalTools: tools.length,
      runtimeToolCount: tools.length,
      declarativeToolCount: 0,
      manifestToolCount: 0,
      toolsWithSchema: tools.filter((tool) => tool.inputSchema.isStructured).length,
      toolsWithDescription: tools.filter((tool) => !!tool.description).length,
      formCount: forms.length,
      criticalFormCount: 0,
      fullyLabelledFormCount: forms.filter((form) => form.fullyLabelled).length,
      frictionTrapCount: frictionTraps.length,
      trapsBySeverity: { low: 0, medium: 0, high: 0, critical: 0 },
      trapsByType: {},
      hasWebMcpRuntime: tools.length > 0,
      hasWellKnownManifest: false,
      hasLlmsTxt: false,
      agentReadinessScore: 0,
      grade: 'F',
      interactiveControlCount: 0,
      scanDurationMs: 500,
      warningCount: 0,
      errorCount: 0,
    },
    diagnostics: overrides.diagnostics ?? [],
  };
}

/** Recursively asserts that no numeric field anywhere in `value` is `NaN`. */
export function findNonFiniteNumbers(value: unknown, path = '$'): string[] {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? [] : [`${path} = ${String(value)}`];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findNonFiniteNumbers(entry, `${path}[${index}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
      findNonFiniteNumbers(entry, `${path}.${key}`),
    );
  }
  return [];
}
