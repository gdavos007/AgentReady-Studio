/**
 * AgentGrade — WebMCP code remediation engine.
 *
 * Turns any {@link AuditIssue} into drop-in code across three surfaces:
 *
 *  - **Browser native** — a `navigator.modelContext.registerTool({ … })` call.
 *  - **React hook** — the same tool as a `useWebMCP({ … })` declaration.
 *  - **Declarative HTML** — `<form data-mcp-tool="…">` markup and the element
 *    fixes the issue calls for.
 *
 * Everything is derived from the scan: tool names come from the surface's
 * category, schemas from its real fields and their labels, and selectors from
 * the elements the scanner actually found. Generation is pure and deterministic
 * — the same issue and scan always produce byte-identical code, which is what
 * makes the output diffable and testable.
 */

import type {
  AgentAuditRawData,
  DiscoveredField,
  DiscoveredForm,
  FormCategory,
  FrictionTrap,
  JsonValue,
  RegisteredTool,
} from '../scanner/types.js';
import type { AuditIssue } from '../evals/types.js';

/* -------------------------------------------------------------------------- */
/* Contract                                                                    */
/* -------------------------------------------------------------------------- */

/** Which of the three code surfaces a tab targets. */
export type RemediationTabId = 'browser-native' | 'react-hook' | 'declarative-html';

/** The shape of fix an issue calls for. Drives copy and schema inference. */
export type RemediationKind =
  /** Register a tool that replaces an uncovered interactive surface. */
  | 'surface-tool'
  /** Publish or repair a discovery descriptor. */
  | 'descriptor'
  /** Add or tighten a tool's input schema. */
  | 'schema'
  /** Fix read/write annotations. */
  | 'annotation'
  /** Give elements accessible names. */
  | 'labelling'
  /** Replace an agent-hostile structure (iframe, scroll nest, fake button). */
  | 'structural';

/** Languages the generated tabs emit, for the highlighter and the copy label. */
export type CodeLanguage = 'javascript' | 'tsx' | 'html' | 'json';

/** One copyable code tab. */
export interface RemediationTab {
  id: RemediationTabId;
  label: string;
  language: CodeLanguage;
  /** Suggested filename, shown above the snippet. */
  filename: string;
  code: string;
  /** One sentence on what this snippet does and where it goes. */
  explanation: string;
}

/** Everything the drawer needs to render a fix for one issue. */
export interface RemediationBundle {
  issueId: string;
  kind: RemediationKind;
  /** Inferred tool name, or `null` when the fix registers no tool. */
  toolName: string | null;
  /** One-line statement of the fix. */
  summary: string;
  /** The selectors this fix touches, echoed from the issue. */
  targetSelectors: string[];
  tabs: RemediationTab[];
}

/** A tool signature inferred from the scan, shared by all three tabs. */
export interface InferredTool {
  name: string;
  description: string;
  /** JSON Schema object, ready to serialise. */
  inputSchema: JsonSchemaObject;
  /** True when the action changes state. Drives `readOnlyHint`. */
  mutates: boolean;
  /** True when the change is not easily undone. Drives `destructiveHint`. */
  destructive: boolean;
  /** The surface the tool replaces, when there is one. */
  form: DiscoveredForm | null;
}

/** The JSON Schema subset the generator emits. */
export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
  additionalProperties: false;
}

/** One property of {@link JsonSchemaObject}. */
export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean';
  description: string;
  format?: string;
  enum?: string[];
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Generates the three-tab remediation bundle for an issue.
 *
 * Pure: no clock, no randomness, no I/O.
 */
export function generateRemediation(issue: AuditIssue, data: AgentAuditRawData): RemediationBundle {
  const kind = classifyIssue(issue);
  const form = resolveForm(issue, data);
  const tool = inferTool(issue, data, form, kind);

  const tabs: RemediationTab[] = [
    {
      id: 'browser-native',
      label: 'Browser Native',
      language: 'javascript',
      filename: 'webmcp-tools.js',
      code: renderBrowserNative(issue, tool, kind, data),
      explanation:
        'Drop this into a script that runs after your app mounts. It registers the tool directly on the WebMCP runtime, with no framework dependency.',
    },
    {
      id: 'react-hook',
      label: 'React Hook',
      language: 'tsx',
      filename: `${toKebabCase(tool.name)}.tsx`,
      code: renderReactHook(issue, tool, kind),
      explanation:
        'Declarative equivalent for a React component. `useWebMCP` registers on mount and unregisters on unmount, so the tool tracks the component that owns the action.',
    },
    {
      id: 'declarative-html',
      label: 'Declarative HTML',
      language: 'html',
      filename: 'markup.html',
      code: renderDeclarativeHtml(issue, tool, kind, data),
      explanation:
        'Markup-only annotation. An agent that never executes your JavaScript can still read the contract, and the element fixes below remove the friction this issue flagged.',
    },
  ];

  return {
    issueId: issue.id,
    kind,
    toolName: kind === 'descriptor' || kind === 'labelling' ? null : tool.name,
    summary: summarise(issue, tool, kind),
    targetSelectors: issue.relatedSelectors,
    tabs,
  };
}

/** Generates bundles for a whole scorecard, keyed by issue id. */
export function generateAllRemediations(
  issues: AuditIssue[],
  data: AgentAuditRawData,
): Map<string, RemediationBundle> {
  return new Map(issues.map((issue) => [issue.id, generateRemediation(issue, data)]));
}

/* -------------------------------------------------------------------------- */
/* Issue classification                                                        */
/* -------------------------------------------------------------------------- */

/** Maps an issue id onto the shape of fix it needs. */
export function classifyIssue(issue: AuditIssue): RemediationKind {
  const id = issue.id;
  if (id.startsWith('discovery.missing-llms-txt')) return 'descriptor';
  if (id.startsWith('discovery.missing-well-known')) return 'descriptor';
  if (id.startsWith('discovery.missing-agent-card')) return 'descriptor';
  if (id.startsWith('discovery.weak-semantic-metadata')) return 'structural';
  if (id.startsWith('safety.mislabelled-read-only') || id.startsWith('safety.missing-read-only')) {
    return 'annotation';
  }
  if (id.startsWith('safety.')) return 'schema';
  if (id.startsWith('friction.unlabelled')) return 'labelling';
  if (id.startsWith('friction.')) return 'structural';
  return 'surface-tool';
}

/** Finds the surface an issue is about, when it names one. */
function resolveForm(issue: AuditIssue, data: AgentAuditRawData): DiscoveredForm | null {
  const formId = typeof issue.evidence.formId === 'string' ? issue.evidence.formId : null;
  if (formId) {
    const byId = data.forms.find((form) => form.id === formId);
    if (byId) return byId;
  }

  // A friction issue names selectors; the owning surface is the one containing
  // the first of them.
  for (const selector of issue.relatedSelectors) {
    const owner = data.forms.find((form) => selector.startsWith(form.selector));
    if (owner) return owner;
  }

  const category = typeof issue.evidence.category === 'string' ? issue.evidence.category : null;
  if (category) {
    const byCategory = data.forms.find((form) => form.category === category);
    if (byCategory) return byCategory;
  }

  // Fall back to the highest-value surface, so a schema or annotation issue
  // still produces a concrete, site-specific example.
  const priority: FormCategory[] = ['checkout', 'authentication', 'signup', 'search'];
  for (const wanted of priority) {
    const match = data.forms.find((form) => form.category === wanted);
    if (match) return match;
  }
  return data.forms[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Tool inference                                                              */
/* -------------------------------------------------------------------------- */

/** Idiomatic tool names per surface category. */
const CATEGORY_TOOL_NAMES: Readonly<Record<FormCategory, string>> = {
  search: 'search_products',
  checkout: 'place_order',
  authentication: 'sign_in',
  signup: 'create_account',
  contact: 'contact_support',
  newsletter: 'subscribe_newsletter',
  filter: 'filter_results',
  'modal-trigger': 'open_dialog',
  generic: 'submit_form',
};

/** Categories whose action changes state. */
const MUTATING_CATEGORIES: ReadonlySet<FormCategory> = new Set<FormCategory>([
  'checkout',
  'signup',
  'authentication',
  'contact',
  'newsletter',
]);

/** Categories whose action is not easily undone. */
const DESTRUCTIVE_CATEGORIES: ReadonlySet<FormCategory> = new Set<FormCategory>(['checkout']);

/** One-line descriptions per category, used when the scan supplies none. */
const CATEGORY_DESCRIPTIONS: Readonly<Record<FormCategory, string>> = {
  search: 'Search the catalog and return matching items.',
  checkout: 'Place the order for the items currently in the cart.',
  authentication: 'Sign a customer in and start an authenticated session.',
  signup: 'Create a new customer account.',
  contact: 'Open a support conversation on the customer’s behalf.',
  newsletter: 'Subscribe an email address to the newsletter.',
  filter: 'Apply filters to the current result set and return the matches.',
  'modal-trigger': 'Open the dialog this control reveals and return its contents.',
  generic: 'Submit this form and return the result.',
};

/**
 * Derives a complete tool signature from the scan.
 *
 * For a `surface-tool` issue the schema mirrors the form's real fields. For a
 * `schema` or `annotation` issue it starts from the tool the site already
 * registered, so the generated snippet is a *correction* rather than a
 * replacement the developer has to reconcile by hand.
 */
export function inferTool(
  issue: AuditIssue,
  data: AgentAuditRawData,
  form: DiscoveredForm | null,
  kind: RemediationKind,
): InferredTool {
  const existing = resolveExistingTool(issue, data);

  if (existing && (kind === 'schema' || kind === 'annotation')) {
    const fromForm = form ? schemaFromForm(form) : emptySchema();
    return {
      name: existing.name,
      description: existing.description ?? CATEGORY_DESCRIPTIONS[form?.category ?? 'generic'],
      // Keep the site's own parameters, but documented and typed.
      inputSchema: mergeSchemas(schemaFromTool(existing), fromForm),
      mutates: isMutating(existing, form),
      destructive: isDestructive(existing, form),
      form,
    };
  }

  const category: FormCategory = form?.category ?? 'generic';
  const baseName = CATEGORY_TOOL_NAMES[category];
  const name = form && category === 'generic' ? `submit_${toSnakeCase(form.name ?? form.id)}` : baseName;

  return {
    name,
    description: form?.name ? `${CATEGORY_DESCRIPTIONS[category]}` : CATEGORY_DESCRIPTIONS[category],
    inputSchema: form ? schemaFromForm(form) : emptySchema(),
    mutates: MUTATING_CATEGORIES.has(category),
    destructive: DESTRUCTIVE_CATEGORIES.has(category),
    form,
  };
}

/** Finds the registered tool an issue is complaining about, if any. */
function resolveExistingTool(issue: AuditIssue, data: AgentAuditRawData): RegisteredTool | null {
  const named = [
    ...(Array.isArray(issue.evidence.mislabelled) ? (issue.evidence.mislabelled as string[]) : []),
    ...(Array.isArray(issue.evidence.unannotatedMutations) ? (issue.evidence.unannotatedMutations as string[]) : []),
    ...(Array.isArray(issue.evidence.unstructured) ? (issue.evidence.unstructured as string[]) : []),
    ...(Array.isArray(issue.evidence.undocumented) ? (issue.evidence.undocumented as string[]) : []),
    ...(Array.isArray(issue.evidence.missingRequired) ? (issue.evidence.missingRequired as string[]) : []),
    ...(Array.isArray(issue.evidence.unclear) ? (issue.evidence.unclear as string[]) : []),
  ];
  for (const name of named) {
    const match = data.tools.find((tool) => tool.name === name);
    if (match) return match;
  }
  return null;
}

function isMutating(tool: RegisteredTool, form: DiscoveredForm | null): boolean {
  if (tool.annotations['readOnlyHint'] === true) {
    // The audit flagged this exact claim as wrong, so trust the name instead.
    return /\b(add|create|place|submit|buy|pay|order|delete|update|remove|send|subscribe|register)\b/i.test(
      tool.name.replace(/[_-]+/g, ' '),
    );
  }
  if (tool.annotations['readOnlyHint'] === false) return true;
  return form ? MUTATING_CATEGORIES.has(form.category) : false;
}

function isDestructive(tool: RegisteredTool, form: DiscoveredForm | null): boolean {
  if (tool.annotations['destructiveHint'] === true) return true;
  return /\b(delete|remove|cancel|place|pay|purchase|order)\b/i.test(tool.name.replace(/[_-]+/g, ' '))
    ? true
    : form
      ? DESTRUCTIVE_CATEGORIES.has(form.category)
      : false;
}

/* -------------------------------------------------------------------------- */
/* Schema inference                                                            */
/* -------------------------------------------------------------------------- */

function emptySchema(): JsonSchemaObject {
  return { type: 'object', properties: {}, required: [], additionalProperties: false };
}

/** Maps an input's `type` onto a JSON Schema type and format. */
function schemaTypeForField(field: DiscoveredField): { type: JsonSchemaProperty['type']; format?: string } {
  switch (field.type) {
    case 'email':
      return { type: 'string', format: 'email' };
    case 'url':
      return { type: 'string', format: 'uri' };
    case 'tel':
      return { type: 'string', format: 'phone' };
    case 'date':
      return { type: 'string', format: 'date' };
    case 'datetime-local':
      return { type: 'string', format: 'date-time' };
    case 'number':
    case 'range':
      return { type: 'number' };
    case 'checkbox':
      return { type: 'boolean' };
    case 'password':
      return { type: 'string', format: 'password' };
    default:
      return { type: 'string' };
  }
}

/**
 * Builds a schema from a surface's real fields.
 *
 * Property names come from the field's `name`/`id`, camel-cased; descriptions
 * come from its accessible name, which is exactly the text a human was already
 * shown. Where the scanner found no label, the description says so — an honest
 * placeholder beats an invented one, and it points the developer at the second
 * thing they need to fix.
 */
export function schemaFromForm(form: DiscoveredForm): JsonSchemaObject {
  const schema = emptySchema();

  for (const field of form.fields) {
    if (field.type === 'hidden' || field.type === 'submit' || field.type === 'button') continue;
    const property = toCamelCase(field.name || field.id || field.type);
    if (!property || property in schema.properties) continue;

    const { type, format } = schemaTypeForField(field);
    const description = field.accessibleName
      ? `${field.accessibleName}.`
      : `TODO: describe the "${field.name || field.id || field.type}" field — the scan found no accessible name for it.`;

    schema.properties[property] = format
      ? { type, description, format }
      : { type, description };
    if (field.required) schema.required.push(property);
  }

  return schema;
}

/** Lifts a registered tool's declared schema into the generator's shape. */
function schemaFromTool(tool: RegisteredTool): JsonSchemaObject {
  const schema = emptySchema();
  const raw = tool.inputSchema.raw;
  const properties =
    raw && typeof raw === 'object' && !Array.isArray(raw) && raw.properties && typeof raw.properties === 'object' && !Array.isArray(raw.properties)
      ? (raw.properties as Record<string, JsonValue>)
      : {};

  for (const [name, definition] of Object.entries(properties)) {
    const record =
      definition && typeof definition === 'object' && !Array.isArray(definition)
        ? (definition as Record<string, JsonValue>)
        : {};
    const declaredType = typeof record.type === 'string' ? record.type : 'string';
    const type: JsonSchemaProperty['type'] =
      declaredType === 'number' || declaredType === 'integer' || declaredType === 'boolean'
        ? declaredType
        : 'string';
    const description =
      typeof record.description === 'string' && record.description.trim().length > 0
        ? record.description
        : `TODO: describe the "${name}" parameter — the registered schema documents no description.`;

    schema.properties[name] = typeof record.format === 'string'
      ? { type, description, format: record.format }
      : { type, description };
  }

  schema.required.push(...tool.inputSchema.required.filter((name) => name in schema.properties));
  return schema;
}

/** Merges a form-derived schema into a tool-derived one, tool wins on conflict. */
function mergeSchemas(primary: JsonSchemaObject, secondary: JsonSchemaObject): JsonSchemaObject {
  const merged: JsonSchemaObject = {
    type: 'object',
    properties: { ...secondary.properties, ...primary.properties },
    required: Array.from(new Set([...primary.required, ...secondary.required])),
    additionalProperties: false,
  };
  merged.required = merged.required.filter((name) => name in merged.properties);
  return merged;
}

/* -------------------------------------------------------------------------- */
/* Tab A — browser native                                                      */
/* -------------------------------------------------------------------------- */

function renderBrowserNative(
  issue: AuditIssue,
  tool: InferredTool,
  kind: RemediationKind,
  data: AgentAuditRawData,
): string {
  if (kind === 'descriptor') return renderDescriptorScript(issue, data);

  const header = [
    `// AgentGrade remediation — ${issue.id}`,
    `// ${issue.title}`,
    `// Fixes: ${wrapComment(issue.impactDescription)}`,
    '',
  ];

  // The form path drives real inputs, so the snippet ships the two helpers it
  // needs — a developer should be able to paste this and have it work.
  const prelude = tool.form
    ? [
        'const setValue = (element, value) => {',
        '  if (!element) return;',
        '  element.value = String(value);',
        "  element.dispatchEvent(new Event('input', { bubbles: true }));",
        "  element.dispatchEvent(new Event('change', { bubbles: true }));",
        '};',
        '',
        'const setChecked = (element, value) => {',
        '  if (!element) return;',
        '  element.checked = Boolean(value);',
        "  element.dispatchEvent(new Event('change', { bubbles: true }));",
        '};',
        '',
      ]
    : [];

  const body = [
    ...prelude,
    'if (window.navigator.modelContext) {',
    '  navigator.modelContext.registerTool({',
    `    name: ${quote(tool.name)},`,
    `    description: ${quote(tool.description)},`,
    `    inputSchema: ${indentBlock(JSON.stringify(tool.inputSchema, null, 2), 4)},`,
    '    annotations: {',
    `      readOnlyHint: ${String(!tool.mutates)},`,
    `      destructiveHint: ${String(tool.destructive)},`,
    '    },',
    `    async execute(${destructureArgs(tool)}) {`,
    ...renderExecuteBody(tool, kind).map((line) => `      ${line}`),
    '    },',
    '  });',
    '}',
  ];

  return [...header, ...body, ''].join('\n');
}

/** The body of `execute`, wired to the real surface where one exists. */
function renderExecuteBody(tool: InferredTool, kind: RemediationKind): string[] {
  if (!tool.form) {
    return [
      '// TODO: call the same application code your UI handler calls.',
      'const result = await performAction();',
      'return { content: [{ type: "text", text: JSON.stringify(result) }] };',
    ];
  }

  const lines: string[] = [
    '// Drive the same code path as the UI so the tool and the form cannot',
    '// drift apart. Reusing the DOM keeps validation and analytics intact.',
    `const form = document.querySelector(${quote(playwrightToCss(tool.form.selector))});`,
    'if (!form) {',
    '  return { content: [{ type: "text", text: "Surface is not mounted." }], isError: true };',
    '}',
    '',
  ];

  for (const [property, definition] of Object.entries(tool.inputSchema.properties)) {
    const field = tool.form.fields.find(
      (candidate) => toCamelCase(candidate.name || candidate.id || candidate.type) === property,
    );
    if (!field) continue;
    const selector = quote(playwrightToCss(field.selector));
    if (definition.type === 'boolean') {
      lines.push(`setChecked(form.querySelector(${selector}), ${property});`);
    } else {
      lines.push(`setValue(form.querySelector(${selector}), ${property});`);
    }
  }

  lines.push(
    '',
    kind === 'surface-tool' && tool.mutates
      ? '// A mutating tool submits only when the caller has supplied every required value.'
      : '// Submit through the native path so the app\'s own handlers run.',
    'form.requestSubmit();',
    '',
    'return { content: [{ type: "text", text: "Submitted." }] };',
  );

  return lines;
}

/** Emits the descriptor files a discovery issue asks for. */
function renderDescriptorScript(issue: AuditIssue, data: AgentAuditRawData): string {
  const tools = data.tools.slice(0, 12);
  if (issue.id.includes('llms-txt')) {
    const lines = [
      '// Serve this at /llms.txt (Content-Type: text/plain; charset=utf-8).',
      '// AgentGrade remediation — ' + issue.id,
      '',
      'export const LLMS_TXT = `# ' + escapeTemplate(data.page.title ?? 'Your site') + '',
      '',
      '> ' + escapeTemplate(data.page.description ?? 'One sentence describing what this site does.'),
      '',
      '## Capabilities',
      '',
      ...(tools.length > 0
        ? tools.map(
            (tool) =>
              `- [${escapeTemplate(humanise(tool.name))}](/api/${toKebabCase(tool.name)}): ${escapeTemplate(tool.description ?? 'TODO: describe this capability.')}`,
          )
        : ['- [TODO](/api/example): Describe each capability an agent can use.']),
      '`;',
      '',
    ];
    return lines.join('\n');
  }

  if (issue.id.includes('agent-card')) {
    const card = {
      name: data.page.title ?? 'Your service',
      description: data.page.description ?? 'TODO: one sentence describing this service.',
      url: data.navigation.finalUrl ?? data.target.requestedUrl,
      version: '1.0.0',
      skills: tools.map((tool) => ({
        id: toKebabCase(tool.name),
        name: tool.name,
        description: tool.description ?? 'TODO: describe this skill.',
      })),
    };
    return [
      '// Serve this at /.well-known/agent.json (Content-Type: application/json).',
      '// AgentGrade remediation — ' + issue.id,
      '',
      `export const AGENT_CARD = ${JSON.stringify(card, null, 2)};`,
      '',
    ].join('\n');
  }

  const manifest = {
    schemaVersion: '2025-06-18',
    name: toKebabCase(data.page.title ?? 'your-service'),
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? 'TODO: describe this tool.',
      inputSchema: tool.inputSchema.raw ?? { type: 'object', properties: {} },
    })),
  };
  return [
    '// Serve this at /.well-known/mcp (Content-Type: application/json).',
    '// AgentGrade remediation — ' + issue.id,
    '// An agent that never executes your JavaScript can still discover these.',
    '',
    `export const MCP_MANIFEST = ${JSON.stringify(manifest, null, 2)};`,
    '',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* Tab B — React hook                                                          */
/* -------------------------------------------------------------------------- */

function renderReactHook(issue: AuditIssue, tool: InferredTool, kind: RemediationKind): string {
  const componentName = toPascalCase(tool.name);
  const argsType = renderTypeScriptArgs(tool.inputSchema);

  const header = [
    `// AgentGrade remediation — ${issue.id}`,
    `// ${issue.title}`,
    '',
    "'use client';",
    '',
    "import { useWebMCP } from '@/hooks/useWebMCP';",
    '',
  ];

  if (kind === 'descriptor') {
    return [
      ...header,
      '// Discovery descriptors are served, not registered — see the Browser Native',
      '// tab for the file contents. Expose them from a route handler:',
      '',
      `export async function GET() {`,
      `  return new Response(JSON.stringify(MCP_MANIFEST), {`,
      `    headers: { 'content-type': 'application/json' },`,
      `  });`,
      `}`,
      '',
    ].join('\n');
  }

  const body = [
    `interface ${componentName}Args ${argsType}`,
    '',
    `export function ${componentName}Tool() {`,
    '  useWebMCP({',
    `    name: ${quote(tool.name)},`,
    `    description: ${quote(tool.description)},`,
    `    inputSchema: ${indentBlock(JSON.stringify(tool.inputSchema, null, 2), 4)} as const,`,
    '    annotations: {',
    `      readOnlyHint: ${String(!tool.mutates)},`,
    `      destructiveHint: ${String(tool.destructive)},`,
    '    },',
    `    async execute(args: ${componentName}Args) {`,
    ...renderHookExecuteBody(tool).map((line) => `      ${line}`),
    '    },',
    '  });',
    '',
    '  return null;',
    '}',
  ];

  return [...header, ...body, ''].join('\n');
}

function renderHookExecuteBody(tool: InferredTool): string[] {
  const properties = Object.keys(tool.inputSchema.properties);
  if (properties.length === 0) {
    return [
      '// TODO: call the same mutation/query your submit handler calls.',
      'const result = await performAction();',
      'return { content: [{ type: "text", text: JSON.stringify(result) }] };',
    ];
  }
  return [
    '// Call the same handler your form\'s onSubmit calls — one code path,',
    '// so the tool cannot drift away from the UI.',
    `const result = await ${toCamelCase(tool.name)}(args);`,
    '',
    'return { content: [{ type: "text", text: JSON.stringify(result) }] };',
  ];
}

/** Renders the schema as a TypeScript interface body. */
function renderTypeScriptArgs(schema: JsonSchemaObject): string {
  const entries = Object.entries(schema.properties);
  if (entries.length === 0) return '{\n  [key: string]: never;\n}';

  const lines = entries.map(([name, definition]) => {
    const optional = schema.required.includes(name) ? '' : '?';
    const tsType = definition.type === 'integer' ? 'number' : definition.type;
    return `  /** ${definition.description} */\n  ${name}${optional}: ${tsType};`;
  });
  return `{\n${lines.join('\n')}\n}`;
}

/* -------------------------------------------------------------------------- */
/* Tab C — declarative HTML                                                    */
/* -------------------------------------------------------------------------- */

function renderDeclarativeHtml(
  issue: AuditIssue,
  tool: InferredTool,
  kind: RemediationKind,
  data: AgentAuditRawData,
): string {
  const parts: string[] = [
    `<!-- AgentGrade remediation — ${issue.id} -->`,
    `<!-- ${issue.title} -->`,
  ];

  if (kind === 'descriptor') {
    parts.push(
      '',
      '<!-- Advertise the descriptors from the document head so a crawler finds them -->',
      '<link rel="mcp-manifest" href="/.well-known/mcp" type="application/json" />',
      '<link rel="agent-card" href="/.well-known/agent.json" type="application/json" />',
      '<link rel="llms-txt" href="/llms.txt" type="text/plain" />',
      '',
    );
    return parts.join('\n');
  }

  if (kind === 'labelling' || kind === 'structural') {
    parts.push('', ...renderElementFixes(issue, data));
  }

  if (tool.form) {
    parts.push('', '<!-- Annotate the surface so the tool and the form are provably the same action -->');
    parts.push(renderAnnotatedForm(tool));
  } else if (kind !== 'labelling') {
    parts.push(
      '',
      '<!-- No form was catalogued for this issue; annotate the element that performs the action -->',
      `<button type="button" data-mcp-tool="${escapeAttribute(tool.name)}" data-mcp-description="${escapeAttribute(tool.description)}">`,
      `  ${escapeText(humanise(tool.name))}`,
      '</button>',
    );
  }

  parts.push('');
  return parts.join('\n');
}

/** Renders the `<form data-mcp-tool>` annotation with matching field names. */
function renderAnnotatedForm(tool: InferredTool): string {
  const form = tool.form!;
  // Escaped for a double-quoted attribute like every other attribute below —
  // one quoting convention across the generator means one escaping rule.
  const schemaAttribute = escapeAttribute(JSON.stringify(tool.inputSchema));

  const lines = [
    `<form`,
    `  data-mcp-tool="${escapeAttribute(tool.name)}"`,
    `  data-mcp-description="${escapeAttribute(tool.description)}"`,
    `  data-mcp-schema="${schemaAttribute}"`,
    form.action ? `  action="${escapeAttribute(form.action)}"` : '  action="/api/submit"',
    `  method="${escapeAttribute((form.method ?? 'POST').toLowerCase())}"`,
    '>',
  ];

  for (const [property, definition] of Object.entries(tool.inputSchema.properties)) {
    const field = form.fields.find(
      (candidate) => toCamelCase(candidate.name || candidate.id || candidate.type) === property,
    );
    const inputId = toKebabCase(property);
    const label = field?.accessibleName ?? humanise(property);
    const inputType = htmlInputType(definition);
    const required = tool.inputSchema.required.includes(property) ? ' required' : '';
    lines.push(
      `  <label for="${escapeAttribute(inputId)}">${escapeText(label)}</label>`,
      `  <input id="${escapeAttribute(inputId)}" name="${escapeAttribute(field?.name || property)}" type="${inputType}"${required} />`,
    );
  }

  lines.push('  <button type="submit">' + escapeText(humanise(tool.name)) + '</button>', '</form>');
  return lines.join('\n');
}

/** Element-level before/after fixes for labelling and structural issues. */
function renderElementFixes(issue: AuditIssue, data: AgentAuditRawData): string[] {
  const traps = data.frictionTraps.filter((trap) => issue.relatedSelectors.includes(trap.selector));
  if (traps.length === 0) {
    return ['<!-- No element-level trap selectors were recorded for this issue. -->'];
  }

  const lines: string[] = [];
  for (const trap of traps.slice(0, 4)) {
    lines.push(
      `<!-- ${trap.selector} -->`,
      `<!-- ${trap.recommendation} -->`,
      ...fixForTrap(trap),
      '',
    );
  }
  return lines;
}

/** The concrete markup fix for one trap type. */
function fixForTrap(trap: FrictionTrap): string[] {
  switch (trap.type) {
    case 'unlabelled-control':
      return [
        `<${trap.tagName} aria-label="TODO: name the action this control performs">`,
        '  <!-- existing icon / children -->',
        `</${trap.tagName}>`,
      ];
    case 'unlabelled-input':
      return [
        '<label for="field-id">TODO: the value this field expects</label>',
        '<input id="field-id" name="field-name" type="text" />',
      ];
    case 'opaque-iframe':
      return [
        '<iframe',
        '  title="TODO: what this frame contains, e.g. Payment card entry"',
        '  src="…"',
        '></iframe>',
      ];
    case 'non-semantic-control':
      return [
        '<!-- was: <div class="btn" onclick="…">…</div> -->',
        '<button type="button" onclick="…">',
        '  <!-- existing children -->',
        '</button>',
      ];
    case 'multi-step-non-semantic':
      return [
        '<nav aria-label="Checkout steps">',
        '  <button type="button">Back</button>',
        '  <button type="button" aria-current="step">Next</button>',
        '</nav>',
      ];
    case 'nested-scroll-container':
      return [
        '<!-- Replace the inner scroll region with real pagination -->',
        '<ul>',
        '  <!-- items -->',
        '</ul>',
        '<a href="?page=2" rel="next">Next page</a>',
      ];
    case 'closed-shadow-surface':
      return [
        '<!-- In the custom element: this.attachShadow({ mode: "open" }) -->',
        `<${trap.tagName} aria-label="TODO: describe this widget's current state">`,
        `</${trap.tagName}>`,
      ];
    case 'pointer-only-interaction':
      return [
        '<li draggable="true">',
        '  Item',
        '  <button type="button" aria-label="Move item up">↑</button>',
        '  <button type="button" aria-label="Move item down">↓</button>',
        '</li>',
      ];
    default:
      return ['<!-- TODO: apply the recommendation above. -->'];
  }
}

/** Maps a schema property onto the closest HTML input type. */
function htmlInputType(definition: JsonSchemaProperty): string {
  if (definition.type === 'boolean') return 'checkbox';
  if (definition.type === 'number' || definition.type === 'integer') return 'number';
  if (definition.format === 'email') return 'email';
  if (definition.format === 'uri') return 'url';
  if (definition.format === 'phone') return 'tel';
  if (definition.format === 'date') return 'date';
  if (definition.format === 'password') return 'password';
  return 'text';
}

/* -------------------------------------------------------------------------- */
/* Summary copy                                                                */
/* -------------------------------------------------------------------------- */

function summarise(issue: AuditIssue, tool: InferredTool, kind: RemediationKind): string {
  switch (kind) {
    case 'surface-tool':
      return `Register \`${tool.name}\` so agents can perform this action in one call instead of driving ${tool.form?.fields.length ?? 0} field(s) of DOM.`;
    case 'descriptor':
      return 'Publish the discovery descriptor so agents can find your capabilities without executing the page.';
    case 'schema':
      return `Give \`${tool.name}\` a typed, documented input schema so the model gets the arguments right first time.`;
    case 'annotation':
      return `Declare read/write intent on \`${tool.name}\` so an agent knows whether calling it is safe.`;
    case 'labelling':
      return `Name ${issue.relatedSelectors.length || 'the affected'} element(s) so an agent can address them by intent.`;
    case 'structural':
      return 'Replace the agent-hostile structure with semantic markup, and expose the action as a tool.';
  }
}

/* -------------------------------------------------------------------------- */
/* String helpers                                                              */
/* -------------------------------------------------------------------------- */

/** JSON-quotes a string for embedding in generated source. */
export function quote(value: string): string {
  return JSON.stringify(value);
}

/** Indents every line but the first, for embedding a JSON block in a literal. */
function indentBlock(block: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  const [first, ...rest] = block.split('\n');
  return [first, ...rest.map((line) => `${pad}${line}`)].join('\n');
}

/** Destructures the schema's properties into `execute`'s parameter list. */
function destructureArgs(tool: InferredTool): string {
  const properties = Object.keys(tool.inputSchema.properties);
  return properties.length === 0 ? '' : `{ ${properties.join(', ')} }`;
}

/**
 * The scanner emits Playwright selectors, which may pierce shadow roots with
 * `>>>`. `document.querySelector` cannot, so generated code targets the
 * deepest plain-CSS segment and the drawer shows the full path separately.
 */
export function playwrightToCss(selector: string): string {
  const segments = selector.split('>>>');
  return (segments[segments.length - 1] ?? selector).trim();
}

/** True when a selector crosses a shadow boundary. */
export function piercesShadowDom(selector: string): boolean {
  return selector.includes('>>>');
}

/** `search products` → `searchProducts`. */
export function toCamelCase(value: string): string {
  const words = splitWords(value);
  if (words.length === 0) return '';
  return words
    .map((word, index) => (index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join('');
}

/** `search products` → `SearchProducts`. */
export function toPascalCase(value: string): string {
  const camel = toCamelCase(value);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

/** `searchProducts` → `search_products`. */
export function toSnakeCase(value: string): string {
  return splitWords(value).join('_');
}

/** `searchProducts` → `search-products`. */
export function toKebabCase(value: string): string {
  return splitWords(value).join('-');
}

/** `search_products` → `Search products`. */
export function humanise(value: string): string {
  const words = splitWords(value);
  if (words.length === 0) return '';
  return words.join(' ').replace(/^./, (character) => character.toUpperCase());
}

/** Splits an identifier of any casing into lowercase words. */
function splitWords(value: string): string[] {
  return (value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/**
 * Escapes a value for an HTML attribute.
 *
 * Both quote characters are escaped, not just the double quote. Every value
 * here originates in the audited page — a form label, a tool name, a
 * description — and the output is code the studio tells a developer to paste
 * into their own site. A single unescaped `'` closes the attribute and the rest
 * of the label becomes markup: `x' onfocus='alert(1)' autofocus x` parses as
 * two real event-handler attributes. That is stored XSS delivered through
 * remediation advice, so this function escapes for *any* attribute context.
 */
export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escapes a value for HTML text content. */
export function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escapes backticks and `${` so a value is safe inside a template literal. */
function escapeTemplate(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/** Collapses a sentence onto one comment line. */
function wrapComment(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 160);
}
