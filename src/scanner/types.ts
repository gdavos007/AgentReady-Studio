/**
 * AgentGrade — inspection engine data contract.
 *
 * Every field produced by the scanner is described here. The engine never emits
 * partial objects: when a value cannot be determined it is emitted as `null`
 * (unknown) or as an empty collection, never as `undefined`, so that the JSON
 * serialisation of an {@link AuditReport} is stable and diffable across runs.
 */

import type { Grade } from '../shared/grade.js';

export type { Grade } from '../shared/grade.js';

/** Schema version of {@link AgentAuditRawData}. Bump on any breaking change. */
export const AUDIT_SCHEMA_VERSION = '1.0.0' as const;
export type AuditSchemaVersion = typeof AUDIT_SCHEMA_VERSION;

/* -------------------------------------------------------------------------- */
/* Tools                                                                       */
/* -------------------------------------------------------------------------- */

/** Where a tool declaration was observed. */
export type ToolSource =
  /** `window.navigator.modelContext` — the WebMCP runtime registry. */
  | 'navigator.modelContext'
  /** `document.modelContext` — legacy/alternate runtime registry. */
  | 'document.modelContext'
  /** A `<tool-definition>` / `<mcp-tool>` custom element in the DOM. */
  | 'declarative-element'
  /** A `<form data-mcp-tool="...">` annotation. */
  | 'declarative-form'
  /** `/.well-known/mcp` (or `/.well-known/mcp.json`). */
  | 'well-known-mcp'
  /** `/.well-known/agent.json` (agent card / A2A style descriptor). */
  | 'well-known-agent'
  /** `/llms.txt` free-form capability listing. */
  | 'llms-txt';

/** A JSON-Schema-ish description of a tool's input. Kept loose on purpose: */
export interface ToolInputSchema {
  /** Raw schema object exactly as the page exposed it (already JSON-safe). */
  raw: JsonValue | null;
  /** `type` field of the schema, when present (usually `"object"`). */
  type: string | null;
  /** Top-level property names, in declaration order. Empty when unknown. */
  propertyNames: string[];
  /** Property names listed as required. Empty when unknown or none. */
  required: string[];
  /** True when the schema parsed into a usable object with properties. */
  isStructured: boolean;
}

/** A single agent-callable tool discovered on the target. */
export interface RegisteredTool {
  /** Stable identifier: `${source}:${name}` lowercased, unique per report. */
  id: string;
  /** Tool name as declared. Empty string when the declaration omitted it. */
  name: string;
  /** Human/agent readable description, or `null` when not declared. */
  description: string | null;
  /** Normalised input schema. */
  inputSchema: ToolInputSchema;
  /** Declared output schema, when the site exposes one. */
  outputSchema: JsonValue | null;
  /** Discovery channel. */
  source: ToolSource;
  /** True when the tool has a callable `execute`/`handler` at runtime. */
  executable: boolean;
  /** Optional annotations (e.g. `readOnlyHint`, `destructiveHint`). */
  annotations: Record<string, JsonValue>;
  /** CSS selector of the declaring element, for declarative sources. */
  selector: string | null;
  /** Absolute URL of the manifest that declared it, for static sources. */
  manifestUrl: string | null;
}

/* -------------------------------------------------------------------------- */
/* Runtime WebMCP state                                                        */
/* -------------------------------------------------------------------------- */

/** Result of probing one `modelContext` host object. */
export interface ModelContextProbe {
  /** The probed path, e.g. `navigator.modelContext`. */
  path: 'navigator.modelContext' | 'document.modelContext';
  /** Whether the property exists at all. */
  present: boolean;
  /** `typeof` the value, or `null` when absent. */
  valueType: string | null;
  /** Enumerable + prototype method names exposed by the object. */
  apiSurface: string[];
  /** True when a WebMCP-shaped registration API is available. */
  supportsRegistration: boolean;
  /** Tools read back from this host object. */
  tools: RegisteredTool[];
  /** Error message if reading the object threw. */
  error: string | null;
}

/** Aggregated runtime WebMCP state for the page. */
export interface RuntimeWebMcpState {
  /** True when at least one probe found a usable registry. */
  detected: boolean;
  /** Milliseconds waited for the registry to appear (0 when immediate). */
  settleMs: number;
  /** Per-path probe results, always both paths, in a fixed order. */
  probes: ModelContextProbe[];
  /** Union of tools from all probes, de-duplicated by `id`. */
  tools: RegisteredTool[];
}

/* -------------------------------------------------------------------------- */
/* Declarative / static discovery                                              */
/* -------------------------------------------------------------------------- */

/** Outcome of fetching one well-known / static descriptor. */
export interface DescriptorProbe {
  /** Absolute URL that was requested. */
  url: string;
  /** Logical name of the descriptor. */
  kind: 'well-known-mcp' | 'well-known-agent' | 'llms-txt';
  /** True when the resource responded 2xx with a non-empty body. */
  found: boolean;
  /** HTTP status code, or `null` when the request never completed. */
  status: number | null;
  /** `content-type` response header, lowercased, or `null`. */
  contentType: string | null;
  /** Response body, truncated to {@link MAX_DESCRIPTOR_BYTES}. */
  body: string | null;
  /** Parsed JSON body when the payload was valid JSON. */
  json: JsonValue | null;
  /** Byte length of the untruncated body. */
  byteLength: number;
  /**
   * True when the response exceeded {@link MAX_DESCRIPTOR_TRANSFER_BYTES} and
   * was refused. `body` and `json` are null in that case: a partial descriptor
   * would score as malformed, which is a different finding from an oversized
   * one.
   */
  oversized?: boolean;
  /** Transport/parse error message, or `null` on success. */
  error: string | null;
}

/** Maximum number of body characters retained per descriptor probe. */
export const MAX_DESCRIPTOR_BYTES = 64_000;

/**
 * Hard ceiling on what a single descriptor fetch may transfer.
 *
 * `MAX_DESCRIPTOR_BYTES` bounds what is *retained*; this bounds what is *read*.
 * Without it, `/.well-known/mcp` answering with an endless body is a
 * remote-triggered OOM: the scanner fetches three descriptors on every scan
 * from an origin it does not control, so the target chooses the size.
 *
 * Four times the retention cap, so a large-but-legitimate manifest is still
 * read in full and reported as truncated rather than rejected outright.
 */
export const MAX_DESCRIPTOR_TRANSFER_BYTES = MAX_DESCRIPTOR_BYTES * 4;

/** A declarative WebMCP annotation found in the served markup. */
export interface DeclarativeToolTag {
  /** Tag name, lowercased, e.g. `tool-definition`. */
  tagName: string;
  /** CSS selector locating the element. */
  selector: string;
  /** Tool name resolved from `name`/`data-mcp-tool`/`id`, or empty string. */
  name: string;
  /** Description resolved from `description`/`data-mcp-description`. */
  description: string | null;
  /** All attributes on the element, verbatim. */
  attributes: Record<string, string>;
  /** Inline JSON payload (schema) when the element carried one. */
  inlineSchema: JsonValue | null;
  /** True when the tag was found in the raw HTML rather than the live DOM. */
  staticOnly: boolean;
}

/** Everything discovered without executing page tool calls. */
export interface DeclarativeDiscovery {
  /** Descriptor fetches, always one entry per probed kind. */
  descriptors: DescriptorProbe[];
  /** Declarative tags found in the live DOM and/or the raw HTML. */
  tags: DeclarativeToolTag[];
  /** Tools derived from descriptors and tags. */
  tools: RegisteredTool[];
  /** `<link rel="...">` hints pointing at agent manifests. */
  manifestLinks: ManifestLink[];
}

/** A `<link>`/`<meta>` hint that advertises an agent manifest. */
export interface ManifestLink {
  rel: string;
  href: string;
  type: string | null;
  /** Resolved absolute URL of `href`. */
  resolved: string;
}

/* -------------------------------------------------------------------------- */
/* Interactive surface                                                         */
/* -------------------------------------------------------------------------- */

/** Coarse classification of an interactive surface. */
export type FormCategory =
  | 'search'
  | 'checkout'
  | 'authentication'
  | 'signup'
  | 'contact'
  | 'newsletter'
  | 'filter'
  | 'modal-trigger'
  | 'generic';

/** A single input control belonging to a {@link DiscoveredForm}. */
export interface DiscoveredField {
  /** `input` | `select` | `textarea` | custom element tag, lowercased. */
  tagName: string;
  /** `type` attribute for inputs, otherwise the tag name. */
  type: string;
  /** `name` attribute, or empty string. */
  name: string;
  /** `id` attribute, or empty string. */
  id: string;
  /** Resolved accessible name (label, aria-label, placeholder, …). */
  accessibleName: string | null;
  /** How the accessible name was derived. `null` when unnamed. */
  labelSource: 'label-element' | 'aria-label' | 'aria-labelledby' | 'placeholder' | 'title' | 'value' | null;
  /** True when `required` or `aria-required="true"`. */
  required: boolean;
  /** `autocomplete` token, or `null`. */
  autocomplete: string | null;
  /** CSS selector for the field. */
  selector: string;
}

/** An interactive surface an agent would need to drive. */
export interface DiscoveredForm {
  /** Stable per-report identifier, e.g. `form-3`. */
  id: string;
  /** `form` for real `<form>` elements, otherwise the container tag. */
  tagName: string;
  /** True when this is a real `<form>` element. */
  isNativeForm: boolean;
  /** CSS selector for the container. */
  selector: string;
  /** Best-effort human name (aria-label, legend, heading, …). */
  name: string | null;
  /** Inferred purpose. */
  category: FormCategory;
  /** `action` attribute resolved to an absolute URL, when present. */
  action: string | null;
  /** HTTP method, uppercased. `null` for non-form containers. */
  method: string | null;
  /** Fields belonging to the surface. */
  fields: DiscoveredField[];
  /** Submit-like controls inside the surface. */
  submitControls: InteractiveControl[];
  /** True when every field resolved an accessible name. */
  fullyLabelled: boolean;
  /** True when the surface is inside a dialog/modal container. */
  inModal: boolean;
  /** True when the element is rendered and not `display:none`/zero-sized. */
  visible: boolean;
  /** Ids of friction traps attached to this surface. */
  trapIds: string[];
  /** True when annotated with `data-mcp-tool` or wired to a WebMCP tool. */
  mcpAnnotated: boolean;
}

/** A clickable control catalogued on the page. */
export interface InteractiveControl {
  tagName: string;
  selector: string;
  /** Resolved accessible name, or `null` when the control is unnamed. */
  accessibleName: string | null;
  /** Explicit or implicit ARIA role. */
  role: string | null;
  /** Visible text content, trimmed and collapsed. */
  text: string;
  /** True when keyboard focusable (native control or `tabindex >= 0`). */
  focusable: boolean;
  /** True when rendered and non-zero sized. */
  visible: boolean;
}

/* -------------------------------------------------------------------------- */
/* Friction traps                                                              */
/* -------------------------------------------------------------------------- */

/** Categories of agent-hostile UI patterns detected by the engine. */
export type FrictionTrapType =
  /** A button/clickable with no accessible name. */
  | 'unlabelled-control'
  /** An iframe with no title/name, or injected after load. */
  | 'opaque-iframe'
  /** A nested scroll container that hides content from a flat DOM read. */
  | 'nested-scroll-container'
  /** A `div`/`span` acting as a button without a role. */
  | 'non-semantic-control'
  /** A multi-step flow driven by non-semantic step controls. */
  | 'multi-step-non-semantic'
  /** An input with no programmatic label. */
  | 'unlabelled-input'
  /** Content rendered only inside a shadow root without accessible names. */
  | 'closed-shadow-surface'
  /** A pointer-only interaction (drag/hover) with no keyboard equivalent. */
  | 'pointer-only-interaction';

/** Severity of a detected trap. */
export type TrapSeverity = 'low' | 'medium' | 'high' | 'critical';

/** A concrete agent-hostile pattern with enough context to fix it. */
export interface FrictionTrap {
  /** Stable per-report identifier, e.g. `trap-7`. */
  id: string;
  type: FrictionTrapType;
  severity: TrapSeverity;
  /** CSS selector of the offending element. */
  selector: string;
  /** Lowercased tag name of the offending element. */
  tagName: string;
  /** One-line explanation of why an agent would struggle. */
  message: string;
  /** Machine-readable supporting facts (counts, attribute values, …). */
  evidence: Record<string, JsonValue>;
  /** Concrete remediation hint. */
  recommendation: string;
  /** Id of the {@link DiscoveredForm} this trap sits inside, when any. */
  formId: string | null;
}

/* -------------------------------------------------------------------------- */
/* Navigation & diagnostics                                                    */
/* -------------------------------------------------------------------------- */

/** How the navigation attempt ended. */
export type NavigationStatus =
  | 'loaded'
  /** DOM was usable but the network never went idle before the budget. */
  | 'timeout-soft'
  /** Navigation itself timed out; nothing usable was rendered. */
  | 'timeout-hard'
  /** DNS/TLS/connection failure. */
  | 'network-error'
  /** Server answered with 4xx/5xx. */
  | 'http-error'
  /** Navigation was blocked (bot wall, captcha, consent interstitial). */
  | 'blocked';

/** Result of the navigation phase. */
export interface NavigationOutcome {
  status: NavigationStatus;
  /** URL requested by the caller. */
  requestedUrl: string;
  /** URL after redirects, or `null` when navigation failed. */
  finalUrl: string | null;
  /** HTTP status of the main document, or `null`. */
  httpStatus: number | null;
  /** `document.title`, or `null`. */
  title: string | null;
  /** Wall-clock milliseconds spent navigating. */
  durationMs: number;
  /** Number of redirect hops observed on the main frame. */
  redirectCount: number;
  /** True when a bot wall / captcha signature was detected. */
  botWallDetected: boolean;
  /** Signatures that triggered {@link botWallDetected}. */
  botWallSignals: string[];
  /** Error message when the navigation failed, else `null`. */
  error: string | null;
}

/** Severity of a scan-time diagnostic. */
export type DiagnosticLevel = 'info' | 'warning' | 'error';

/** A non-fatal (or fatal) event recorded during the scan. */
export interface ScanDiagnostic {
  level: DiagnosticLevel;
  /** Pipeline stage that produced the diagnostic. */
  stage: 'launch' | 'navigate' | 'runtime' | 'descriptors' | 'dom' | 'teardown';
  /** Stable machine-readable code, e.g. `descriptor-fetch-failed`. */
  code: string;
  message: string;
  /** ISO-8601 timestamp. */
  at: string;
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                     */
/* -------------------------------------------------------------------------- */

/** Rolled-up counters and the headline readiness score. */
export interface ScanSummary {
  /** Total tools across every source, de-duplicated. */
  totalTools: number;
  /** Tools observed in the WebMCP runtime registry. */
  runtimeToolCount: number;
  /** Tools declared in markup (`<tool-definition>`, `data-mcp-tool`). */
  declarativeToolCount: number;
  /** Tools declared in `/.well-known/*` or `/llms.txt`. */
  manifestToolCount: number;
  /** Tools that carry a structured input schema. */
  toolsWithSchema: number;
  /** Tools that carry a non-empty description. */
  toolsWithDescription: number;
  /** All catalogued interactive surfaces. */
  formCount: number;
  /** Surfaces categorised as checkout/auth/search/signup. */
  criticalFormCount: number;
  /** Surfaces where every field has an accessible name. */
  fullyLabelledFormCount: number;
  /** Total friction traps. */
  frictionTrapCount: number;
  /** Trap counts keyed by severity; all four keys always present. */
  trapsBySeverity: Record<TrapSeverity, number>;
  /** Trap counts keyed by type; only non-zero types are present. */
  trapsByType: Partial<Record<FrictionTrapType, number>>;
  /** True when a runtime WebMCP registry was found. */
  hasWebMcpRuntime: boolean;
  /** True when `/.well-known/mcp` or `/.well-known/agent.json` resolved. */
  hasWellKnownManifest: boolean;
  /** True when `/llms.txt` resolved. */
  hasLlmsTxt: boolean;
  /** 0–100 composite readiness score. */
  agentReadinessScore: number;
  /**
   * Letter grade derived from {@link agentReadinessScore}, on the shared
   * {@link Grade} scale — the same bands the Phase 2 scorecard uses.
   */
  grade: Grade;
  /** Total interactive controls catalogued on the page. */
  interactiveControlCount: number;
  /** Wall-clock duration of the whole scan. */
  scanDurationMs: number;
  /** Count of `warning` diagnostics. */
  warningCount: number;
  /** Count of `error` diagnostics. */
  errorCount: number;
}

/* -------------------------------------------------------------------------- */
/* Top-level contract                                                          */
/* -------------------------------------------------------------------------- */

/** Details about what was scanned. */
export interface ScanTarget {
  /** URL as supplied by the caller. */
  requestedUrl: string;
  /** Origin of the final URL, or of the requested URL when navigation failed. */
  origin: string;
  /** ISO-8601 start timestamp. */
  startedAt: string;
  /** ISO-8601 finish timestamp. */
  finishedAt: string;
  /** User agent string actually used by the browser context. */
  userAgent: string;
  /** Viewport used for the scan. */
  viewport: { width: number; height: number };
}

/** Page-level metadata collected from the DOM. */
export interface PageMetadata {
  title: string | null;
  lang: string | null;
  description: string | null;
  /** Count of `<main>`, `<nav>`, `<header>`… landmark elements. */
  landmarkCount: number;
  /** True when the page exposes exactly one `<main>` landmark. */
  hasSingleMainLandmark: boolean;
  /** Heading levels present, ascending, e.g. `[1, 2, 3]`. */
  headingLevels: number[];
  /** Number of elements in the DOM (cheap complexity proxy). */
  domNodeCount: number;
  /** Number of open shadow roots encountered. */
  shadowRootCount: number;
  /** Number of iframes on the page. */
  iframeCount: number;
  /** True when a `<noscript>`-only body was served (SPA shell). */
  requiresJavaScript: boolean;
}

/** The strict raw-data payload. Everything the engine measured. */
export interface AgentAuditRawData {
  schemaVersion: AuditSchemaVersion;
  /** Random-ish per-scan identifier. */
  scanId: string;
  target: ScanTarget;
  navigation: NavigationOutcome;
  page: PageMetadata;
  runtime: RuntimeWebMcpState;
  declarative: DeclarativeDiscovery;
  /** De-duplicated union of every tool from every source. */
  tools: RegisteredTool[];
  forms: DiscoveredForm[];
  controls: InteractiveControl[];
  frictionTraps: FrictionTrap[];
  summary: ScanSummary;
  diagnostics: ScanDiagnostic[];
}

/** Overall outcome of a scan. */
export type AuditStatus =
  /** Page loaded and every stage completed. */
  | 'ok'
  /** Page loaded but at least one stage degraded (timeouts, blocked fetches). */
  | 'partial'
  /** The page could not be inspected at all. */
  | 'failed';

/** The value returned by {@link import('./engine').scanUrl}. */
export interface AuditReport {
  status: AuditStatus;
  /** ISO-8601 timestamp of report creation. */
  generatedAt: string;
  /** Wall-clock duration of the scan in milliseconds. */
  durationMs: number;
  /** The strict data payload. */
  data: AgentAuditRawData;
}

/* -------------------------------------------------------------------------- */
/* Engine options                                                              */
/* -------------------------------------------------------------------------- */

/** Tuning knobs for {@link import('./engine').scanUrl}. */
export interface ScannerOptions {
  /** Hard cap for the whole scan. Default 60_000 ms. */
  totalTimeoutMs?: number;
  /** Navigation timeout for the main document. Default 30_000 ms. */
  navigationTimeoutMs?: number;
  /** Extra budget spent waiting for the network to quiesce. Default 5_000 ms. */
  networkIdleTimeoutMs?: number;
  /** How long to wait for `modelContext` to appear. Default 3_000 ms. */
  modelContextTimeoutMs?: number;
  /** Per-descriptor fetch timeout. Default 8_000 ms. */
  descriptorTimeoutMs?: number;
  /** Run the browser headless. Default `true`. */
  headless?: boolean;
  /** Override the user agent sent by the context. */
  userAgent?: string;
  /** Viewport for the scan. Default 1440×900. */
  viewport?: { width: number; height: number };
  /** `Accept-Language` value. Default `en-US,en;q=0.9`. */
  locale?: string;
  /** IANA timezone for the context. Default `America/New_York`. */
  timezoneId?: string;
  /** Extra HTTP headers merged into every request. */
  extraHttpHeaders?: Record<string, string>;
  /** Upstream proxy for both navigation and descriptor fetches. */
  proxy?: { server: string; bypass?: string; username?: string; password?: string };
  /**
   * Permit scanning private, loopback, and link-local targets, and `file://`.
   *
   * Off by default: the scanner is a browser pointed at a caller-supplied URL,
   * so without this it would read cloud metadata and internal services for
   * anyone who can submit a target. Defaults to
   * `AGENTGRADE_ALLOW_PRIVATE_TARGETS=1` when unset.
   */
  allowPrivateTargets?: boolean;
  /**
   * Launch Chromium with `--no-sandbox`.
   *
   * Only for unprivileged containers that cannot provide user namespaces.
   * Defaults to `AGENTGRADE_NO_SANDBOX=1` when unset.
   */
  disableSandbox?: boolean;
  /**
   * Serve the page with its Content-Security-Policy disabled.
   *
   * Off by default. The scanner injects init scripts, and a target's CSP is
   * one of the few things standing between a hostile page and those scripts'
   * privileges; disabling it site-wide to make instrumentation marginally
   * easier trades a real boundary for a convenience. Enabling it records a
   * `csp-bypassed` warning in the report so a scan run this way is never
   * mistaken for a normal one.
   */
  bypassCsp?: boolean;
  /**
   * Accept invalid, expired, and self-signed TLS certificates.
   *
   * Off by default. The audit reports on a site's agent readiness, and a
   * report gathered over a connection that was not authenticated is a report
   * about whatever answered — the scanner cannot tell the reader which. Enable
   * it only for a staging host with a known-bad certificate; it records a
   * `tls-errors-ignored` warning.
   */
  ignoreHttpsErrors?: boolean;
  /**
   * Consult `/robots.txt` and refuse a target it disallows.
   *
   * Off by default: the studio's own fixtures and a developer auditing their
   * own staging box are not crawling, and a scanner that silently refused them
   * would be baffling. A corpus run over sites that did not ask to be measured
   * is the case this exists for.
   *
   * Checked before Chromium launches — the point of respecting robots is to not
   * make the request, and a check after navigation has already made it.
   */
  respectRobots?: boolean;
  /** Skip `/.well-known/*` and `/llms.txt` probing. Default `false`. */
  skipDescriptors?: boolean;
  /** Reuse an already-launched browser instead of launching one. */
  browser?: PlaywrightBrowserLike;
  /** Enable the Chrome DevTools Protocol session. Default `true`. */
  enableCdp?: boolean;
  /**
   * Overrides how `/robots.txt` is fetched when {@link respectRobots} is on.
   *
   * Injected for tests, so the rule matching can be exercised without a network
   * round trip. Returns `null` for a transport failure.
   */
  robotsFetcher?: (robotsUrl: string) => Promise<{ status: number; text: string } | null>;
  /** Sink for verbose progress logs. Defaults to a no-op. */
  onDiagnostic?: (diagnostic: ScanDiagnostic) => void;
}

/**
 * Minimal structural type for a Playwright `Browser`. Declared structurally so
 * that callers can inject a browser (or a stub) without importing Playwright.
 */
export interface PlaywrightBrowserLike {
  newContext(options?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* JSON helpers                                                                */
/* -------------------------------------------------------------------------- */

/** Any value that survives `JSON.stringify` unchanged. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/* -------------------------------------------------------------------------- */
/* Raw browser-side payload                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Exactly what {@link import('./dom-inspector').inspectAgentSurface} returns
 * from inside the page. The engine post-processes this into report shapes.
 */
export interface DomInspectionResult {
  page: PageMetadata;
  probes: ModelContextProbe[];
  tags: DeclarativeToolTag[];
  manifestLinks: ManifestLink[];
  forms: DiscoveredForm[];
  controls: InteractiveControl[];
  frictionTraps: FrictionTrap[];
  /** Messages for anything the in-page pass could not read. */
  errors: string[];
}
